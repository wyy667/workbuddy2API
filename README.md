# WorkBuddy2API

WorkBuddy2API exposes a WorkBuddy-compatible upstream through an OpenAI-compatible API and includes a web-based admin console.

> For personal learning and research. Review the upstream service terms and your local requirements before use.

## Features

- OpenAI-compatible chat completions API
- Web admin console for accounts, usage, models, keys, and request logs
- Multi-account management, automatic account switching, and scheduled check-ins
- Optional per-key model, account, request, and token limits
- Request concurrency controls and persistence safeguards

## Requirements

- Linux server for the deployment scripts
- Node.js 22 or newer
- Your own WorkBuddy account

## Quick start

See [README-deploy.md](README-deploy.md) for the full deployment and upgrade instructions. In short:

```bash
# Copy this project to your server, then run:
bash setup-server.sh
```

The setup script installs and configures the service. Keep the generated API key private. Restrict the admin port to trusted IP addresses.

## Development

The admin console source is in `frontend/`; the deployable assets are in `admin-ui/` and `admin.html`.

```bash
cd frontend
npm ci
npm run build
```

See [frontend/README.md](frontend/README.md), [frontend/DEPLOYMENT.md](frontend/DEPLOYMENT.md), and [backend/REQUEST-MAP.md](backend/REQUEST-MAP.md) for more details.

## Data and credentials

Runtime credentials, `.env`, account archives, generated databases, release bundles, and test output are intentionally excluded from Git. The project does not include WorkBuddy accounts or API keys.

## License

No project-wide license has been selected yet. Unless a license is added, standard copyright restrictions apply. Third-party assets and bundled components retain their respective licenses; see `frontend/licenses/` and `backend/vendor-source/UNDICI-LICENSE`.
