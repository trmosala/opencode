# Fedora 44

Build the branded RPM on Linux:

```bash
CM_BRAND=1 CM_UNSIGNED=1 OPENCODE_CHANNEL=dev bun run build
CM_BRAND=1 CM_UNSIGNED=1 OPENCODE_CHANNEL=dev bun x electron-builder --linux rpm --publish never --config electron-builder.fedora.config.ts
```

Install the resulting package:

```bash
sudo dnf install ./dist/cookiemonster-linux-x86_64.rpm
```

The `cookiemonster-desktop` GitHub Actions workflow includes the RPM in CookieMonster releases and verifies installation in a Fedora 44 container.
