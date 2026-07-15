# Security policy

Price Scout treats target pages as untrusted input and deliberately limits its
first release to unauthenticated, read-only public product pages. Do not use it
to bypass access controls or automate purchases.

Report suspected vulnerabilities through the repository's **Security** tab by
selecting **Report a vulnerability**; private vulnerability reporting is
enabled. Include a minimal reproduction, affected version, impact, and any
evidence needed to validate the issue. Do not include live credentials, browser
profiles, cookies, or session recordings in a public issue.

The default Compose port binds to localhost. Anyone exposing the console on a
network must place an authenticated TLS reverse proxy in front of it and rotate
the worker API token and webhook secrets.

## Deployment boundary

The supplied Compose and Kind manifests are local, single-operator portfolio
environments. They are not a hardened multi-tenant browser service. Local
Chromium runs with `--no-sandbox` because the image has no setuid sandbox; the
worker container therefore supplies the isolation boundary. A browser exploit
could reach credentials held by that worker even when the container itself is
non-root, capability-free, and protected by `no-new-privileges`/seccomp.

URL validation resolves and rejects private or special-use addresses before a
job starts, and Stagehand restricts HTTP requests by hostname. Neither mechanism
pins the IP used by subsequent browser connections, so a hostile hostname can
attempt DNS rebinding. Production deployments must put browsers behind an
egress proxy or equivalent policy that resolves and pins approved public IPs,
denies private, special-use, link-local, and cloud-metadata networks, and
separates browser workers from control-plane and notification credentials.
Do not accept monitor creation from untrusted users until those controls and
authentication are in place.
