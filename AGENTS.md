# Repository Guidelines

## Project Structure & Module Organization
TruePay is a Firebase-based cryptocurrency exchange backend built with Node.js 22. The project follows a modular architecture to separate business logic from transport and data layers:

- **`functions/http/`**: Thin handlers for HTTP, Callables, and Webhooks (e.g., `partnerApi.js`, `webhookApi.js`).
- **`functions/services/`**: Core business logic layer (e.g., `walletService.js`, `transactionService.js`).
- **`functions/libs/`**: Shared data access, auth, and legacy logic (e.g., `firestore.js`, `rates.js`).
- **`functions/triggers/`**: Background triggers for Firestore and Auth events.
- **`functions/jobs/`**: Scheduled tasks (e.g., `rateUpdater.js`).
- **`functions/utils/`**: General-purpose utilities (logging, validation).

The root directory contains Firebase configuration files (`firebase.json`, `firestore.rules`) and extensive documentation in Markdown format.

## Build, Test, and Development Commands
Commands should be executed within the `functions/` directory unless otherwise specified.

- **`npm install`**: Install dependencies.
- **`npm run serve`**: Start Firebase emulators for local development.
- **`npm run shell`**: Open the interactive Firebase functions shell.
- **`npm run deploy`**: Deploy functions to the production environment.
- **`npm run logs`**: Stream Cloud Function logs.
- **`node test-functions.js`** (Root): Run local HTTP endpoint tests against the emulators.

## Coding Style & Naming Conventions
- **Language**: JavaScript (Node.js 22).
- **Tooling**: ESLint with `eslint-config-google`.
- **Formatting**: Double quotes are required; template literals are allowed.
- **Naming**: Use `camelCase` for variables and functions.
- **Modules**: CommonJS (`require`/`module.exports`) is used throughout the project.
- **Structure**: Maintain the "Service" pattern—business logic belongs in `services/`, not in HTTP handlers.

## Testing Guidelines
- **Local Testing**: Use `node test-functions.js` from the root directory to verify HTTP endpoints. Ensure emulators are running via `npm run serve`.
- **Framework**: `firebase-functions-test` is available for unit and integration testing.
- **Backwards Compatibility**: Ensure that changes do not break existing consumer app APIs (documented in `README_HIGH_LEVEL.md`).

## Commit & Pull Request Guidelines
While previous history uses generic messages (e.g., "updates"), contributors should follow descriptive conventions:
- **`feat:`**: New features or functionality.
- **`fix:`**: Bug fixes.
- **`refactor:`**: Code changes that neither fix a bug nor add a feature.
- **`docs:`**: Documentation updates.
