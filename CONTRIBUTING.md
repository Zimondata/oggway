# Contributing to ClaudeClaw

Thanks for your interest. Here's how to get involved.

## Development setup

```bash
git clone https://github.com/sbusso/claudeclaw.git
cd claudeclaw
npm install
npm run build
npm test
```

Node 20+ required. Run `npm run dev` for hot-reload during development.

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run typecheck && npm run format:check && npm test`
4. Open a PR against `main`

## Adding a channel

Channels live in `src/channels/`. To add a new one:

1. Create `src/channels/your-channel.ts`
2. Implement the `Channel` interface from `src/orchestrator/types.ts`
3. Call `registerChannel()` to self-register
4. Import it in `src/service.ts`
5. Add any required env vars to `.env.example`

See `src/channels/telegram.ts` for a working example.

## Adding an extension

Extensions are installable packages in `extensions/claudeclaw-*/`. Each needs:

1. `manifest.json` - declares name, type, entry, dependencies, env keys
2. `src/index.ts` - entry point that calls `registerExtension()` or `registerChannel()`
3. `tsconfig.json` - compiles against core `.d.ts` output

See `CLAUDE.md` for the full extension API.

## Adding a skill

Skills are markdown files in `skills/`. They describe a capability the agent can be asked to perform. The setup wizard copies skill files into the instance.

To add a skill:

1. Create `skills/your-skill.md` with the skill prompt
2. Test it locally: run `claude` in your ClaudeClaw directory and invoke `/your-skill`

## Code style

- TypeScript strict mode
- Prettier for formatting (runs on commit via Husky)
- No `any` types unless absolutely necessary
- Prefer Zod validation at boundaries
- No em-dashes or en-dashes in strings - use plain hyphens

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
```

Tests use Vitest. Place test files next to source: `foo.ts` -> `foo.test.ts`.

## Commit messages

Use conventional format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

Keep the first line under 72 characters. Body optional but appreciated for non-trivial changes.

## Security

If you find a security vulnerability, please do NOT open a public issue. Email the maintainers directly (see SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
