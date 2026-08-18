# Lesson 01 facilitator guide: Node and the coding harness

## Outcome

At the end of 60 minutes, each learner should be able to sketch the CookieMonster system from memory and answer:

1. What is executing the code?
2. What folder and context can the harness access?
3. What tools and permissions does the agent have?
4. What evidence will prove the task is complete?

They do not need to write JavaScript.

## Preparation

- Open `lesson-01-node-and-the-coding-harness.html` in a browser.
- Have CookieMonster available for a live demonstration.
- Create a disposable folder containing two or three harmless text files, or use a copy of a non-sensitive creative project.
- Confirm the organization’s rules for client data before showing a real project.

## Run of show

### 0–5 min — Reset the framing

Ask: “When you type a request into CookieMonster, what actually does the work?” Collect answers without correcting them yet.

State the lesson promise: they will leave able to see the machinery, choose the safe mode, and detect when the agent has not really finished.

### 5–18 min — JavaScript, Node.js, and Bun

Use the After Effects analogy:

- An expression is instructions; After Effects is the application that interprets and executes them.
- A `.js` file is instructions; a JavaScript runtime executes them.
- A browser contains a runtime with browser abilities.
- Node.js is a runtime outside the browser with operating-system abilities such as files and networking.
- CookieMonster’s repository primarily uses Bun, a Node.js-compatible runtime and toolkit. The conceptual model transfers, but the command used here is often `bun`, not `node` or `npm`.

Where the analogy stops: Node.js is not a visual application, timeline, renderer, or permanent background service. A Node process begins, does work, and either keeps running or exits.

Show the root `package.json`, but only point out:

- `packageManager`: which toolkit this project expects;
- `scripts`: named project actions;
- `dependencies`: reusable packages the project needs.

Do not explain JSON syntax yet.

### 18–33 min — The harness

Define the coding harness as the working system around the model. It assembles context, gives the model tools, enforces permissions, runs actions, captures results, and maintains the session.

Use the studio analogy:

- model = creative problem-solver;
- harness = producer plus production desk;
- project folder = the job folder;
- tools = departments and equipment;
- permissions = approval gates;
- tests, previews, and diffs = QC;
- session = the job’s working conversation and activity history.

Where the analogy stops: the model and harness are software components, not accountable human specialists. The user remains responsible for the brief, approvals, and final judgement.

### 33–43 min — Map CookieMonster

Walk left to right through the system map in the lesson:

1. The designer supplies intent and selects a project folder.
2. CookieMonster/OpenCode manages the session, rules, context, tools, and permissions.
3. The WPP-hosted model decides the next useful step from the context it receives.
4. Local tools inspect or change the project and return evidence.
5. The harness repeats the loop until it reports an outcome or needs a decision.

Emphasize: the model does not directly possess a folder, terminal, or magic view of the whole computer. The harness mediates those capabilities.

### 43–53 min — Safe live demonstration

Open a disposable folder in CookieMonster. Start in Plan and use:

> Without changing anything, inspect this folder. Explain what is here, what you still do not know, and propose one small useful change. Cite the files you used as evidence.

Ask the room to identify the objective, scope, mode, tools, and evidence.

Then switch intentionally to Build and use:

> Create `handoff-notes.md`. Summarize the folder in five bullets, add a section called “Questions”, and do not change any existing file. Afterward, list exactly what changed.

Review the file and change summary. The success is not that the agent said “done”; the success is that the requested artifact exists, is in scope, and matches the acceptance criteria.

### 53–60 min — Quiz and debrief

Use the interactive check in the lesson. Then ask each learner to finish this sentence:

> CookieMonster can act on a project because the harness…

Do not add terms to `GLOSSARY.md` until learners can explain them without reading the lesson.

## Misconceptions to catch

- “Node is JavaScript.” JavaScript is the language; Node.js is one runtime that executes it.
- “The terminal is Node.” The terminal launches commands; Node or Bun may be one of the programs it launches.
- “CookieMonster is the model.” CookieMonster is the desktop harness; the model is one component behind it.
- “The model sees my computer.” It receives selected context and tool results through the harness.
- “A confident final message proves the work.” Completion requires external evidence: changed files, a diff, a test, a preview, or another observable result.
- “Plan can never act.” Treat Plan as the analysis-first mode and still read any approval prompt; exact permissions can be configured.

## Assessment rubric

Ready for module 2:

- Correctly places runtime, model, harness, tools, and project folder on the map.
- Can explain why selecting the wrong folder changes the task’s scope.
- Uses Plan for uncertain exploration and Build only when an edit is intended.
- Names an appropriate verification method before accepting “done.”

Needs another pass:

- Treats CookieMonster as an all-seeing chatbot.
- Cannot distinguish the terminal, runtime, model, and harness.
- Accepts prose as proof of a file or visual change.
- Cannot state which folder is in scope.
