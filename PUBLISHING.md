# Publishing

## Every release

```sh
just release 0.1.1
```

That's it. GitHub Actions handles the rest automatically.

---

## What happens after you push the tag

The release workflow:
1. Runs tests and rebuilds `dist/`
2. Creates a GitHub Release with auto-generated notes
3. Moves the floating `v1` tag to point at the new release

Users referencing `@v1` get the update immediately — no action needed.

---

## First-time Marketplace listing (one-time only)

After the first tag is pushed and the release is created:

1. Go to the release on GitHub and edit it
2. Check **"Publish this Action to the GitHub Marketplace"**
3. Category: **Code quality** + **Security**
4. Save

Subsequent releases appear on the Marketplace automatically.

---

## Prerequisites

- [`just`](https://github.com/casey/just) installed (`brew install just`)
- Push access to this repo
