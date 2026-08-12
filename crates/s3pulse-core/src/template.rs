//! Date placeholders in a feed target, so a date-partitioned feed does not need
//! a new definition every day.
//!
//! `s3://bucket/trades/{yyyy}/{MM}/{dd}/` resolves to today's prefix at every
//! poll, and `s3://bucket/trades/{yyyy}{MM}{dd}/` gives the compact `20260812`
//! form from the same placeholders.
//!
//! Placeholders resolve in **UTC**. That is a deliberate v1 limit rather than an
//! oversight: a per-feed time zone means either compiling the tz database into
//! every bundled binary or getting DST wrong, and the lookback window already
//! absorbs the few hours of skew a non-UTC partitioning scheme would introduce.
//! A time zone can be added later without breaking anything.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};

use crate::TemplateError;

/// The finest unit a template varies by, which is what "one period back" means.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Granularity {
    Hour,
    Day,
    Month,
    Year,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Field {
    Year4,
    Year2,
    Month2,
    Month1,
    Day2,
    Day1,
    Hour2,
    Hour1,
}

impl Field {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "yyyy" => Some(Self::Year4),
            "yy" => Some(Self::Year2),
            "MM" => Some(Self::Month2),
            "M" => Some(Self::Month1),
            "dd" => Some(Self::Day2),
            "d" => Some(Self::Day1),
            "HH" => Some(Self::Hour2),
            "H" => Some(Self::Hour1),
            _ => None,
        }
    }

    fn granularity(self) -> Granularity {
        match self {
            Self::Year4 | Self::Year2 => Granularity::Year,
            Self::Month2 | Self::Month1 => Granularity::Month,
            Self::Day2 | Self::Day1 => Granularity::Day,
            Self::Hour2 | Self::Hour1 => Granularity::Hour,
        }
    }

    fn render(self, at: DateTime<Utc>) -> String {
        match self {
            Self::Year4 => format!("{:04}", at.year()),
            Self::Year2 => format!("{:02}", at.year().rem_euclid(100)),
            Self::Month2 => format!("{:02}", at.month()),
            Self::Month1 => at.month().to_string(),
            Self::Day2 => format!("{:02}", at.day()),
            Self::Day1 => at.day().to_string(),
            Self::Hour2 => format!("{:02}", at.hour()),
            Self::Hour1 => at.hour().to_string(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Segment {
    Literal(String),
    Field(Field),
}

/// A key prefix containing at least one date placeholder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DateTemplate {
    segments: Vec<Segment>,
    granularity: Granularity,
}

impl DateTemplate {
    /// Parses a key prefix.
    ///
    /// Returns `Ok(None)` when the prefix holds no placeholders, so an ordinary
    /// target costs nothing and stays exactly as it was.
    pub fn parse(prefix: &str) -> Result<Option<Self>, TemplateError> {
        let mut segments = Vec::new();
        let mut literal = String::new();
        let mut finest: Option<Granularity> = None;
        let mut characters = prefix.chars().peekable();

        while let Some(character) = characters.next() {
            match character {
                // {{ and }} escape a literal brace, so a key may still contain one.
                '{' if characters.peek() == Some(&'{') => {
                    characters.next();
                    literal.push('{');
                }
                '}' if characters.peek() == Some(&'}') => {
                    characters.next();
                    literal.push('}');
                }
                '{' => {
                    let mut name = String::new();
                    let mut closed = false;
                    for inner in characters.by_ref() {
                        if inner == '}' {
                            closed = true;
                            break;
                        }
                        name.push(inner);
                    }
                    if !closed {
                        return Err(TemplateError::UnclosedPlaceholder);
                    }
                    let field = Field::parse(&name).ok_or_else(|| {
                        // Minutes are the usual confusion, and silently treating
                        // {mm} as a month would produce a plausible wrong prefix.
                        if name == "mm" || name == "m" {
                            TemplateError::MinutesNotMonths
                        } else {
                            TemplateError::UnknownPlaceholder(name.clone())
                        }
                    })?;
                    if !literal.is_empty() {
                        segments.push(Segment::Literal(std::mem::take(&mut literal)));
                    }
                    finest = Some(match finest {
                        Some(current) => finer_of(current, field.granularity()),
                        None => field.granularity(),
                    });
                    segments.push(Segment::Field(field));
                }
                '}' => return Err(TemplateError::UnmatchedBrace),
                other => literal.push(other),
            }
        }
        if !literal.is_empty() {
            segments.push(Segment::Literal(literal));
        }

        match finest {
            None => Ok(None),
            Some(granularity) => Ok(Some(Self {
                segments,
                granularity,
            })),
        }
    }

    pub fn granularity(&self) -> Granularity {
        self.granularity
    }

    /// Renders the prefixes to watch: the period containing `at`, plus
    /// `lookback` earlier ones.
    ///
    /// The lookback exists because a rollover is not clean — files for
    /// yesterday can still land after midnight — and it doubles as slack for a
    /// feed partitioned in a zone other than UTC.
    ///
    /// Newest first, deduplicated.
    pub fn resolve(&self, at: DateTime<Utc>, lookback: u32) -> Vec<String> {
        let mut prefixes = Vec::new();
        for step in 0..=lookback {
            let moment = self.step_back(at, step);
            let rendered = self.render(moment);
            if !prefixes.contains(&rendered) {
                prefixes.push(rendered);
            }
        }
        prefixes
    }

    fn render(&self, at: DateTime<Utc>) -> String {
        let mut out = String::new();
        for segment in &self.segments {
            match segment {
                Segment::Literal(text) => out.push_str(text),
                Segment::Field(field) => out.push_str(&field.render(at)),
            }
        }
        out
    }

    /// Calendar arithmetic, not duration subtraction: months and years are not
    /// fixed numbers of seconds.
    fn step_back(&self, at: DateTime<Utc>, steps: u32) -> DateTime<Utc> {
        if steps == 0 {
            return at;
        }
        let steps = steps as i64;
        match self.granularity {
            Granularity::Hour => at - Duration::hours(steps),
            Granularity::Day => at - Duration::days(steps),
            Granularity::Month => {
                let months = at.year() as i64 * 12 + (at.month() as i64 - 1) - steps;
                let year = months.div_euclid(12) as i32;
                let month = months.rem_euclid(12) as u32 + 1;
                // Clamp the day so stepping back from the 31st into a shorter
                // month stays inside that month.
                let day = at.day().min(days_in_month(year, month));
                Utc.with_ymd_and_hms(year, month, day, at.hour(), at.minute(), at.second())
                    .single()
                    .unwrap_or(at)
            }
            Granularity::Year => {
                let year = at.year() - steps as i32;
                let day = at.day().min(days_in_month(year, at.month()));
                Utc.with_ymd_and_hms(year, at.month(), day, at.hour(), at.minute(), at.second())
                    .single()
                    .unwrap_or(at)
            }
        }
    }
}

fn finer_of(left: Granularity, right: Granularity) -> Granularity {
    let rank = |value: Granularity| match value {
        Granularity::Year => 0,
        Granularity::Month => 1,
        Granularity::Day => 2,
        Granularity::Hour => 3,
    };
    if rank(right) > rank(left) {
        right
    } else {
        left
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_prefix_without_placeholders_is_not_a_template() {
        assert_eq!(DateTemplate::parse("trades/").unwrap(), None);
        assert_eq!(DateTemplate::parse("").unwrap(), None);
    }

    #[test]
    fn hive_style_and_compact_layouts_both_work() {
        let hive = DateTemplate::parse("trades/{yyyy}/{MM}/{dd}/")
            .unwrap()
            .unwrap();
        assert_eq!(
            hive.resolve(at("2026-08-12T09:30:00Z"), 0),
            vec!["trades/2026/08/12/"]
        );

        // The compact yyyymmdd form falls out of the same placeholders.
        let compact = DateTemplate::parse("trades/{yyyy}{MM}{dd}/")
            .unwrap()
            .unwrap();
        assert_eq!(
            compact.resolve(at("2026-08-12T09:30:00Z"), 0),
            vec!["trades/20260812/"]
        );
    }

    #[test]
    fn lookback_covers_the_rollover() {
        let template = DateTemplate::parse("trades/{yyyy}{MM}{dd}/")
            .unwrap()
            .unwrap();
        // Just after midnight, yesterday's prefix can still be receiving files.
        assert_eq!(
            template.resolve(at("2026-08-12T00:05:00Z"), 1),
            vec!["trades/20260812/", "trades/20260811/"]
        );
    }

    #[test]
    fn stepping_back_crosses_month_and_year_boundaries() {
        let daily = DateTemplate::parse("{yyyy}/{MM}/{dd}/").unwrap().unwrap();
        assert_eq!(
            daily.resolve(at("2026-03-01T00:10:00Z"), 1),
            vec!["2026/03/01/", "2026/02/28/"]
        );
        assert_eq!(
            daily.resolve(at("2026-01-01T00:10:00Z"), 1),
            vec!["2026/01/01/", "2025/12/31/"]
        );
        // 2024 is a leap year, so the day before 1 March is the 29th.
        assert_eq!(
            daily.resolve(at("2024-03-01T00:10:00Z"), 1),
            vec!["2024/03/01/", "2024/02/29/"]
        );
    }

    #[test]
    fn granularity_follows_the_finest_placeholder() {
        let hourly = DateTemplate::parse("{yyyy}/{MM}/{dd}/{HH}/")
            .unwrap()
            .unwrap();
        assert_eq!(hourly.granularity(), Granularity::Hour);
        assert_eq!(
            hourly.resolve(at("2026-08-12T00:30:00Z"), 1),
            vec!["2026/08/12/00/", "2026/08/11/23/"]
        );

        let monthly = DateTemplate::parse("{yyyy}/{MM}/").unwrap().unwrap();
        assert_eq!(monthly.granularity(), Granularity::Month);
        assert_eq!(
            monthly.resolve(at("2026-01-15T00:00:00Z"), 1),
            vec!["2026/01/", "2025/12/"]
        );

        // Stepping a month back from the 31st must stay inside the shorter month.
        let monthly_day = DateTemplate::parse("{yyyy}/{MM}/").unwrap().unwrap();
        assert_eq!(
            monthly_day.resolve(at("2026-03-31T00:00:00Z"), 1),
            vec!["2026/03/", "2026/02/"]
        );
    }

    #[test]
    fn unpadded_variants_render_without_leading_zeroes() {
        let template = DateTemplate::parse("{yyyy}-{M}-{d}/").unwrap().unwrap();
        assert_eq!(
            template.resolve(at("2026-08-05T00:00:00Z"), 0),
            vec!["2026-8-5/"]
        );
        let short_year = DateTemplate::parse("{yy}{MM}{dd}/").unwrap().unwrap();
        assert_eq!(
            short_year.resolve(at("2026-08-05T00:00:00Z"), 0),
            vec!["260805/"]
        );
    }

    #[test]
    fn duplicate_periods_are_collapsed() {
        // A yearly template with a large lookback should not list the same
        // prefix repeatedly within one year.
        let yearly = DateTemplate::parse("{yyyy}/").unwrap().unwrap();
        assert_eq!(
            yearly.resolve(at("2026-08-12T00:00:00Z"), 2),
            vec!["2026/", "2025/", "2024/"]
        );
    }

    #[test]
    fn braces_can_still_be_literal() {
        let template = DateTemplate::parse("odd{{name}}/{yyyy}/").unwrap().unwrap();
        assert_eq!(
            template.resolve(at("2026-08-12T00:00:00Z"), 0),
            vec!["odd{name}/2026/"]
        );
        // Escaped braces alone are not a template.
        assert_eq!(DateTemplate::parse("odd{{name}}/").unwrap(), None);
    }

    #[test]
    fn confusing_or_malformed_placeholders_are_rejected_with_a_reason() {
        // {mm} is minutes in most format languages; treating it as a month
        // would silently produce a plausible but wrong prefix.
        assert!(matches!(
            DateTemplate::parse("{yyyy}/{mm}/").unwrap_err(),
            TemplateError::MinutesNotMonths
        ));
        assert!(matches!(
            DateTemplate::parse("{year}/").unwrap_err(),
            TemplateError::UnknownPlaceholder(name) if name == "year"
        ));
        assert!(matches!(
            DateTemplate::parse("{yyyy/").unwrap_err(),
            TemplateError::UnclosedPlaceholder
        ));
        assert!(matches!(
            DateTemplate::parse("yyyy}/").unwrap_err(),
            TemplateError::UnmatchedBrace
        ));
    }
}
