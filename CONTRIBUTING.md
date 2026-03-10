# Contributing to mctl-portal

## Prerequisites

- Node.js 22+
- yarn (`npm install -g yarn`)

## Local Development

```bash
# Install dependencies
yarn install

# Start in development mode
yarn dev

# Build
yarn build
```

## Project Structure

- `packages/app/` — Backstage frontend
- `packages/backend/` — Backstage backend
- `plugins/` — 8 custom backend plugins
- `app-config.yaml` — local development config
- `app-config.production.yaml` — production config

## Making Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Test locally: `yarn dev`
5. Build: `yarn build`
6. Commit using conventional commits
7. Push and open a Pull Request

## Plugin Development

Custom plugins follow Backstage conventions:
- Each plugin in `plugins/{name}/`
- TypeScript strict mode
- Use async/await over raw Promises
- Export plugin via `src/plugin.ts`
