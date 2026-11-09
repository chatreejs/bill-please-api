# Bill Please API Contributing Guidelines

Thank you for taking the time to contribute to our project. Please take a moment to read the following guidelines before contributing:

> **⚠️IMPORTANT**
>
> **Pull Requests _having no issue associated_ with them _will not be accepted_. Firstly get an issue assigned, whether it's already opened or raised by you, and then create a Pull Request.**

## Prerequisites ⚠️

- Open Source Etiquette: If you've never contributed to an open source project before, have a read of [Basic etiquette](https://developer.mozilla.org/en-US/docs/MDN/Community/Open_source_etiquette) for open source projects.

- Basic familiarity with Git and GitHub: If you are also new to these tools, visit [GitHub for complete beginners](https://developer.mozilla.org/en-US/docs/MDN/Contribute/GitHub_beginners) for a comprehensive introduction to them.

- Make sure you have [Bun](https://bun.sh) installed. The version is pinned in `.tool-versions`, so if you use [asdf](https://asdf-vm.com) just run `asdf install`.
- (Optional) [Docker](https://www.docker.com) if you want to test the container build.

---

## How to Contribute 🤔

To get started, look at the existing [**Issues**](https://github.com/chatreejs/bill-please-api/issues) or [**create a new issue**](https://github.com/chatreejs/bill-please-api/issues/new/choose)!

Issues about the web app itself (UI, bill calculation, translations) belong in [bill-please](https://github.com/chatreejs/bill-please/issues).

### Setup guidelines 🪜

Follow these steps to set up Bill Please API on your local machine

1. [Fork](https://github.com/chatreejs/bill-please-api/fork) the project
2. Clone the project to run on your local machine using the following command:

   ```sh
   git clone https://github.com/<your_github_username>/bill-please-api.git
   ```

3. Get into the root directory

   ```sh
   cd bill-please-api
   ```

4. Install all dependencies and create your local config

   ```sh
   bun install
   cp .env.example .env
   ```

5. Create your branch

   ```sh
   git checkout -b <your_branch_name>
   ```

6. Run the server on localhost (http://localhost:3001, watch mode)

   ```sh
   bun dev
   ```

7. Make your changes, then make sure tests and type checks pass

   ```sh
   bun test
   bun run check-types
   ```

8. Stage your changes

   ```sh
   git add <filename>
   ```

9. Commit your changes

   ```sh
   git commit -m "<your-commit-message>"
   ```

10. Push your changes to your branch

    ```sh
    git push origin "<your_branch_name>"
    ```

11. Create a [PULL REQUEST](https://github.com/chatreejs/bill-please-api/compare) 💣

    > Click _compare across forks_ if you don't see your branch

---

## Project Conventions 🧭

- **Keep the receipt contract in sync.** `src/schemas/receipt.ts` mirrors `IReceiptItem` / `IReceiptScanResult` in [bill-please](https://github.com/chatreejs/bill-please/blob/main/src/interfaces/receipt.ts). A change to the response shape needs a matching change in the web app.
- **Always validate scanner output.** Go through `scanReceiptImage(scanner, image)` so a misbehaving model can never return malformed items.
- **Replacing the scanner.** Implement `ReceiptScanner` from `src/scanners/types.ts`, return it from `createScanner` in `src/scanners/index.ts`, and document any new env vars in `.env.example`.
- **New routes** follow the `xxxRoutes(config, scanner)` plugin pattern so they can be tested with an injected scanner.
- **Tests use a stub scanner.** They call `app.handle(new Request(...))` with a stub `ReceiptScanner`. Add tests for any new behavior in `test/`.
- **Never commit secrets** (API keys, `.env`).

---

## Issues 🎃

- Select an issue template from the [issues](https://github.com/chatreejs/bill-please-api/issues/new/choose) tab. Otherwise, choose **Other** if it doesn't match what you're looking for.
- When creating an issue, make sure you fill up all the fields properly.
- Make sure that you are NOT raising a **duplicate issue**.
- **Note:** If you aren't the owner of the issue, please comment that you're willing to work on the issue and wait for maintainers to assign you the issue. Also, don't work on the issue if you're NOT assigned.
- Work on only **ONE** issue at a time.
- **Security vulnerabilities must not be reported as public issues.** See [SECURITY.md](./SECURITY.md).

**Closing the issue** 📍

- If you decide to close the issue, please leave a brief comment describing why (e.g., I'm busy with other obligations.) before you do.
- **Note:** If the Pull Request associated with the issue gets merged and the issue still remains open, it's **your** responsibility to close the issue.

## Commits Message Guidelines 💬

We follow the [Conventional Commits](https://www.conventionalcommits.org) format, the same as [bill-please](https://github.com/chatreejs/bill-please). Each commit message should adhere to the following guidelines:

1. **Type**: The commit type must be one of the following:

   - `feat`: A new feature or enhancement.
   - `fix`: A bug fix.
   - `docs`: Documentation changes.
   - `style`: Code style changes (e.g., formatting, semicolons).
   - `refactor`: Code refactorings with no feature changes or bug fixes.
   - `test`: Adding or improving tests.
   - `chore`: General maintenance tasks, build changes, etc.

2. **Scope** (Optional): The scope provides context for the commit, indicating the specific part of the project being affected. Use a short description in lowercase (e.g., `receipts`, `scanner`, `docker`).

3. **Description**: A brief and meaningful description of the changes made. Start with a capital letter and use the imperative mood (e.g., "Add new feature" instead of "Added new feature").

4. **Issue reference** (Optional): Include the issue number associated with the commit (e.g., `#123`).

#### ✔️ Examples of Valid Commit Messages

- `feat(scanner): Add Gemini vision scanner`
- `fix(receipts): Answer 413 when the image is too large`
- `docs: Update Docker instructions`
- `test: Add tests for the rate limiter`
- `chore: Update dependencies to latest versions`
- `fix: Handle HEIC uploads (#456)`

#### ❌ Examples of Invalid Commit Messages

- `Added new stuff`
- `Fixed a bug`
- `Updated code`
- `scanner update`
- `chore: fixed some stuff`

---

## Making Pull Requests 💥

1. Make sure `bun test` and `bun run check-types` pass before you open a pull request. If you don't know how to resolve a failure, you can ask for help.

2. Each pull request should contain a single logical change or related set of changes that make sense to submit together. If a pull request becomes too large or contains too many unrelated changes, it becomes too difficult to review. In such cases, the reviewer has the right to close your pull request and ask that you submit a separate pull request for each logical set of changes that belong together.

3. Link the issue you have resolved in the pull request description (e.g. Closes/Fixes #99).
4. Use our [Commit messages Guidelines](#commits-message-guidelines-) for your changes.
5. Do not re-open a pull request that a reviewer has closed.
   - Make sure to tick the "Allow edits from maintainers" box. This allows us to directly make minor edits / refactors and saves a lot of time.
     > **Note**
     > If your pull request has merge conflicts with the `main` branch (GitHub checks for this automatically and notifies you), you are responsible for resolving them. You can do this by merging the `main` branch into your branch (`git pull upstream main`), and then pushing the updated branch to your fork (`git push`). If you need more tips, check out [Resolving a merge conflict on GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-on-github).

---

## Remarks ✅

- If something is missing here, or you feel something is not well described, either create a PR, [raise an issue](https://github.com/chatreejs/bill-please-api/issues), or [do a code review of the person’s PR](https://www.freecodecamp.org/news/code-review-tips/) (ensure that your review conforms to the [Code of Conduct](./CODE_OF_CONDUCT.md)).

- By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](./LICENSE).
