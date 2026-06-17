# Changesets

This directory tracks versioning changes via [changesets](https://github.com/changesets/changesets).

Add a changeset before every PR that touches `packages/*`:

```bash
bun run changeset
```

Pick which packages changed, select bump level (patch / minor / major), write a short summary. The file goes into version control. On release, `bun run version` consumes all pending changesets, updates versions + CHANGELOGs, and prepares the publish commit.
