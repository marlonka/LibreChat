# Agents SDK 4.2.2 with the Google SSE fix

This fork uses the tarball for testing and installs. The upstream fix belongs in Agents. The archive includes the SDK source and license and satisfies the API workspace's Agents peer dependency. [Agents commit `9183099`](https://github.com/marlonka/agents/commit/9183099fa1cf1cff8dbc576d12e7b4ba5b8c4545), [LibreChat #18153](https://github.com/LibreChat-AI/LibreChat/issues/18153)

Build from that commit with `npm ci && npm run build && npm pack --ignore-scripts`. Rename the archive to include the commit and update the backend dependency and lockfiles.

Once the fix is published to npm, bump the Agents dependency and peer range, regenerate the lockfiles, and remove this directory and its Docker copy steps.
