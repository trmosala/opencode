# CookieMonster Foundations Resources

## Knowledge

- [Node.js: Introduction to Node.js](https://nodejs.org/learn/getting-started/introduction-to-nodejs)
  The official foundation for understanding JavaScript running outside a browser. Use for: runtime, process, filesystem, and network concepts.
- [Node.js: Modules and packages](https://nodejs.org/api/packages.html)
  The official description of packages and `package.json`. Use for: explaining how a JavaScript project declares its structure.
- [npm: package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
  The official package-manifest reference, including scripts and dependencies. Use for: distinguishing a project manifest from the installed packages.
- [Bun documentation](https://bun.sh/docs)
  The official explanation of Bun as a runtime, package manager, test runner, and bundler. Use for: mapping the general Node.js mental model to CookieMonster's actual development stack.
- [OpenCode: Tools](https://opencode.ai/docs/tools/)
  The upstream harness documentation for tool access and permissions. Use for: explaining how an AI model gains bounded abilities to inspect and change a project.
- [OpenCode: Agents](https://opencode.ai/docs/agents/)
  The upstream explanation of agents, Plan, Build, and tool permissions. Use for: teaching read-only exploration versus implementation.
- [Local: CookieMonster `package.json`](package.json)
  The live project manifest. Use for: showing that this repository selects Bun and exposes named development, lint, and type-check commands.
- [Local: OpenCode README](README.md)
  The upstream product overview on which CookieMonster is built. Use for: grounding “coding harness” in the actual product rather than a generic chatbot analogy.

## Wisdom (Communities)

- Team show-and-tell after each module
  Learners bring one useful result and one confusing or unsafe moment. Use for: developing shared judgement about briefs, scope, and verification.
- Paired first project
  A learner drives CookieMonster while a second learner acts as reviewer. Use for: making approval and evidence-checking a visible team habit.

## Gaps

- The team’s first concrete motion-design use cases and existing comfort with terminals have not yet been recorded.
- Team-specific rules for client data, approved project locations, and acceptable external context need to be added before production exercises.
