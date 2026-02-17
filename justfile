# Default: list available recipes
default:
    @just --list

# Run tests
test:
    npm test

# Build dist/ (committed to repo so the action works without npm install)
build:
    npm run build

# Verify dist/ matches source — same check CI runs
check-dist:
    @git diff --exit-code dist/ || (echo "dist/ is out of date. Run: just build" && exit 1)

# Run the full CI suite locally: test + build + verify dist
ci: test build check-dist

# Cut a release: test, build, commit dist, tag, push
# Usage: just release 1.2.3
release VERSION: ci
    npm version {{VERSION}} --no-git-tag-version
    git add package.json dist/
    git commit -m "Release v{{VERSION}}"
    git tag "v{{VERSION}}"
    git push && git push origin "v{{VERSION}}"
