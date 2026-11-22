# Sandbox Gatekeeper

Sandbox adds a full-page Linux workspace to Workshop. The terminal and file tree work on the same
`/workspace` as a gadget that the owner explicitly connects to Sandbox. Each Workshop Sandbox
account gets its own container. The Worker has no public URL, and the container receives no Worker
credentials. [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/reference/)

## Enable

The account needs Workers Paid and access to Cloudflare Containers. The deploy machine needs Docker
with Linux/amd64 image builds. To opt in, add a `sandbox` entry inside the existing `gatekeepers`
object in `deployment.jsonc`. Give it a unique, stable Worker name.

```jsonc
"sandbox": {
  "name": "my-os-gk-sandbox",
  "vars": { "SANDBOX_INSTANCE_TYPE": "standard-1" }
}
```

`vars` can be omitted. The default is `standard-1` (0.5 vCPU, 4 GiB RAM, 8 GB disk). Supported values
are `lite`, `basic`, and `standard-1` through `standard-4`. Cloudflare bills for the running
instance, including idle time before it stops. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) · [Instance sizes](https://developers.cloudflare.com/containers/platform/limits/)

Run `pnpm cf-os check` for configuration and Worker bundle validation. After an operator-approved
`pnpm cf-os deploy`, connect Sandbox from **Connectors** or from a gadget's connection picker.
Workshop opens an account-confirmation popup on its own origin. After connecting, open **Sandbox**
from the app navigation and select **Open workspace** to start the container. Reload Workshop if the Sandbox navigation item is missing after connecting. Bind **Linux
workspace** to a gadget when the agent needs access. An administrator can disable the Sandbox
connector in Workshop's `/admin`.

## Use the workspace

- The terminal runs Bash with a PTY, resize, and interactive input. Reopening the app can reconnect
  to the shell while the container and its terminal session are still alive.
- The file tree supports browsing, UTF-8 editing, upload, new files and folders, rename, and
  deletion of empty folders or files. **Copy file** copies text or base64 for binary files.
  Workshop's sandboxed iframe does not grant direct browser downloads. Browser file transfers are
  limited to 1 MiB per file.
- An explicitly bound agent can list directories, read UTF-8 files up to 64 KiB, propose file
  writes up to 16 KiB, and propose commands. Each write and command requires manual approval in
  Workshop. Commands have a 60-second deadline, capture up to 12 KiB per output stream, and expose
  their result via `commandStatus()`. Only the last 20 completed or rejected commands are retained
  per binding. Sandbox observations are restricted to the owner.
- The image includes Node.js, Python and Git. Internet access is off. Bake extra packages into
  the [Dockerfile](Dockerfile) for offline use.
- Use **Save and stop** before leaving to snapshot the files. The next open restores the last
  snapshot. Running processes and terminal state end when the container stops. After 10 minutes of
  inactivity, Cloudflare can stop the instance and discard changes since the last save.
  [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)

## Verify the deployment

Open Sandbox as one allowed Workshop user and run `printf 'hello\\n' > hello.txt` in the terminal.
Refresh the file tree and open the file. Bind Sandbox to a gadget and verify it reads the file.
Ask it to run `printf hello`, confirm Workshop requests approval, and check the output after
approval. Confirm a second user sees a different workspace and cannot observe a gadget's Sandbox
reads. Save and stop the first workspace, reopen it, and confirm the file persists. A local
Wrangler dry-run checks the Worker bundle without exercising the hosted snapshot service.
