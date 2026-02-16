# Publishing to GitHub Marketplace

## 1. Create the dedicated repository

```bash
gh repo create bordumb/auths-verify-action --public --description "GitHub Action to verify commit signatures with Auths identity keys"
git clone git@github.com:bordumb/auths-verify-action.git /tmp/auths-verify-action
```

## 2. Sync files from monorepo

```bash
./sync-to-dedicated-repo.sh /tmp/auths-verify-action
```

## 3. Add LICENSE

```bash
cp LICENSE /tmp/auths-verify-action/LICENSE
```

(Copy the Apache-2.0 LICENSE from the auths monorepo root.)

## 4. Commit and push

```bash
cd /tmp/auths-verify-action
git add -A
git commit -m "Initial release"
git push origin main
```

## 5. Tag and release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow will:
- Create a GitHub Release with auto-generated notes
- Update the floating `v1` tag to point to `v1.0.0`

## 6. Publish to Marketplace

1. Go to https://github.com/bordumb/auths-verify-action/releases
2. Edit the `v1.0.0` release
3. Check **"Publish this Action to the GitHub Marketplace"**
4. Select primary category: **Code quality**
5. Select secondary category: **Security**
6. Save

## 7. Verify

Test in any repo:

```yaml
- uses: bordumb/auths-verify-action@v1
  with:
    allowed-signers: '.auths/allowed_signers'
```

Check the Marketplace listing at:
https://github.com/marketplace/actions/auths-verify-commits

## Subsequent releases

1. Make changes in the monorepo at `.github/actions/verify-action/`
2. Run `npm test` and `npm run build` in the action directory
3. Sync: `./sync-to-dedicated-repo.sh /path/to/auths-verify-action`
4. Commit, tag (`v1.x.y`), and push — the release workflow handles the rest
