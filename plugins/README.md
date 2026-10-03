# The Plugins Folder

This is where your own plugins and their associated modules live, each in a
separate folder of its own.

If you want to create a new plugin here, go to your project root directory, run
the command `yarn new`, and follow the on-screen instructions.

You can also check out existing plugins on [the plugin marketplace](https://backstage.io/plugins)!

## Custom plugins

- `work-items-backend`: read-only canonical WorkItem view backed by mctl-api.
  Identity model: the `surface:portal` principal plus `X-MCTL-Surface-Actor`
  (verified SurfaceIdentityLink, mctl-api#350); no admin token. Execution-request
  mutations are gated by `workItems.actionsEnabled` (default `false`). See
  `work-items-backend/CONTRACT.md`.
