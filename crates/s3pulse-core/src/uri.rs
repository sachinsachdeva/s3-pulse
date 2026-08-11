use std::{fmt, str::FromStr};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

use crate::UriParseError;

/// A bucket plus an optional exact object-key prefix.
///
/// Percent escapes are deliberately not decoded: S3 keys are opaque strings,
/// and `%20` may be part of the actual key.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct S3Uri {
    pub bucket: String,
    pub prefix: String,
}

impl S3Uri {
    pub fn new(
        bucket: impl Into<String>,
        prefix: impl Into<String>,
    ) -> Result<Self, UriParseError> {
        let value = Self {
            bucket: bucket.into(),
            prefix: prefix.into(),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn parse(value: &str) -> Result<Self, UriParseError> {
        value.parse()
    }

    pub fn is_bucket_root(&self) -> bool {
        self.prefix.is_empty()
    }

    /// Returns the key/prefix, or `None` for a bucket-root URI.
    pub fn object_key(&self) -> Option<&str> {
        (!self.prefix.is_empty()).then_some(self.prefix.as_str())
    }

    /// Creates an object URI in the same bucket. `key` is a full bucket key,
    /// not a path relative to this URI's current prefix.
    pub fn for_object(&self, key: impl Into<String>) -> Result<Self, UriParseError> {
        Self::new(self.bucket.clone(), key)
    }

    fn validate(&self) -> Result<(), UriParseError> {
        if self.bucket.is_empty() {
            return Err(UriParseError::MissingBucket);
        }
        if self.bucket.len() > 255
            || self.bucket == "."
            || self.bucket == ".."
            || self.bucket.chars().any(|character| {
                character.is_whitespace()
                    || character.is_control()
                    || matches!(character, '/' | '\\' | '?' | '#')
            })
        {
            return Err(UriParseError::InvalidBucket(self.bucket.clone()));
        }
        if self.prefix.chars().any(char::is_control) {
            return Err(UriParseError::InvalidKey);
        }
        Ok(())
    }
}

impl FromStr for S3Uri {
    type Err = UriParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let remainder = value
            .strip_prefix("s3://")
            .ok_or(UriParseError::InvalidScheme)?;
        let (bucket, prefix) = remainder
            .split_once('/')
            .map_or((remainder, ""), |(bucket, prefix)| (bucket, prefix));
        Self::new(bucket, prefix)
    }
}

impl fmt::Display for S3Uri {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "s3://{}", self.bucket)?;
        if !self.prefix.is_empty() {
            write!(formatter, "/{}", self.prefix)?;
        }
        Ok(())
    }
}

impl Serialize for S3Uri {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for S3Uri {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bucket_prefix_and_exact_key_characters() {
        let uri: S3Uri = "s3://example-bucket/a folder/%20/data.parquet"
            .parse()
            .unwrap();
        assert_eq!(uri.bucket, "example-bucket");
        assert_eq!(uri.prefix, "a folder/%20/data.parquet");
        assert_eq!(
            uri.to_string(),
            "s3://example-bucket/a folder/%20/data.parquet"
        );
    }

    #[test]
    fn parses_bucket_root_with_or_without_slash() {
        assert_eq!(S3Uri::parse("s3://bucket").unwrap().prefix, "");
        assert_eq!(S3Uri::parse("s3://bucket/").unwrap().prefix, "");
    }

    #[test]
    fn rejects_wrong_scheme_empty_or_unsafe_bucket_and_control_key() {
        assert_eq!(
            S3Uri::parse("https://bucket/key"),
            Err(UriParseError::InvalidScheme)
        );
        assert_eq!(S3Uri::parse("s3:///key"), Err(UriParseError::MissingBucket));
        assert!(matches!(
            S3Uri::parse("s3://bad bucket/key"),
            Err(UriParseError::InvalidBucket(_))
        ));
        assert_eq!(
            S3Uri::parse("s3://bucket/key\n"),
            Err(UriParseError::InvalidKey)
        );
    }

    #[test]
    fn serde_uses_the_ergonomic_uri_string() {
        let uri = S3Uri::parse("s3://bucket/feed/").unwrap();
        let json = serde_json::to_string(&uri).unwrap();
        assert_eq!(json, r#""s3://bucket/feed/""#);
        assert_eq!(serde_json::from_str::<S3Uri>(&json).unwrap(), uri);
    }
}
