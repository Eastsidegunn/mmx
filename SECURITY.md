# Security

`mmx serve` binds to loopback by default and has no authentication: anyone who can reach its port can edit the diagram. `--allow-external` permits binding to a non-loopback address and exposes that edit access to reachable clients. Host, Origin, and Content-Type checks guard against browser-based cross-site writes; they do not add authentication. Report vulnerabilities privately through [GitHub security advisories](https://github.com/Eastsidegunn/mmx/security/advisories/new).
