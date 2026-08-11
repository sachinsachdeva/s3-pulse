# Security policy

S3 Pulse is designed for read-only monitoring. It does not need `PutObject`,
`DeleteObject`, or permission to change bucket notifications. Scope IAM policy
to the required bucket and prefix whenever possible.

The project delegates authentication to the AWS SDK credential chain and never
persists AWS secret material. Avoid placing credentials in watcher names,
settings, logs, issue reports, or command arguments.

Please report suspected vulnerabilities privately to the repository maintainers
rather than opening a public issue.

