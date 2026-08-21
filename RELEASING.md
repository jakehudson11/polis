# Paired Release Process

Polis and Agora use **paired releases** with synchronized version numbers. Both repositories are tagged with the same version (e.g., `v0.2.0`) to ensure compatibility and simplify rollbacks.

## Version Strategy

- **Format**: `vX.Y.Z` (semantic versioning)
- **Synchronization**: Both repos share the same version number
- **VERSION files**: Each repo stores `X.Y.Z` (without `v` prefix) in root `VERSION` file
- **Git tags**: Both repos tagged as `vX.Y.Z`

## Before Releasing

### 1. Review Changes

Check what's changed since last release:

```bash
# In polis/
git log v0.1.0..HEAD --oneline

# In agora/ (private repo, if checked out locally)
cd <path-to-agora-repo>
git log v0.1.0..HEAD --oneline
```

### 2. Update Documentation

- Update `CHANGELOG.md` (if exists) with notable changes
- Review README for accuracy
- Ensure all new features are documented

### 3. Verify Clean State

```bash
# In polis/
git status  # Should be clean
git branch  # Should be on 'main'

# In agora/ (private repo)
cd <path-to-agora-repo>
git status
git branch
```

## Creating a Paired Release

Releases are typically created from the **Agora repository** using the automated script.

### From Agora (Recommended)

See the Agora repository's RELEASING.md for the complete process.

Quick summary:

```powershell
# From the Agora repository (release-paired.ps1 lives in the Agora repository, not Polis)
cd <path-to-agora-repo>
.\scripts\release-paired.ps1 -Version "0.2.0"
```

This will:
1. Update VERSION files in both repos
2. Create release commits
3. Create and push tags to both repos

### Manual Release (Alternative)

If releasing manually or from a non-Windows system:

#### Step 1: Update VERSION file

```bash
# In polis/
echo "0.2.0" > VERSION
```

#### Step 2: Commit changes

```bash
# In polis/
git add VERSION
git commit -m "chore(release): v0.2.0"
```

#### Step 3: Create tag

```bash
# In polis/
git tag -a v0.2.0 -m "Release v0.2.0"
```

#### Step 4: Push to GitHub

```bash
# In polis/
git push origin main
git push origin v0.2.0
```

**Note**: Don't forget to also release Agora with the same version!

## Verifying the Release

### Check GitHub

- **Polis**: the tags page of the Polis repository on GitHub
- **Agora**: the tags page of the Agora repository on GitHub

Both should show the same tag.

### Check Locally

```bash
# List tags
git tag -l "v*"

# Show tag details
git show v0.2.0

# Verify VERSION file
cat VERSION
```

## Rolling Back to a Previous Version

### Quick Rollback (Read-Only)

Checkout a specific version to inspect or test:

```bash
# In polis/
git checkout v0.1.0

# In agora/ (private repo, if checked out locally)
cd <path-to-agora-repo>
git checkout v0.1.0
```

**Return to main:**
```bash
git switch main
```

### Permanent Rollback

To revert main branch to a previous release:

```bash
# In polis/
git reset --hard v0.1.0
git push origin main --force

# In agora/ (private repo)
cd <path-to-agora-repo>
git reset --hard v0.1.0
git push origin main --force
```

⚠️ **Warning**: Force pushing rewrites history. Coordinate with your team first.

### Rollback with New Commit (Safer)

Create a new commit that reverts to the old version:

```bash
# In polis/
git revert --no-commit HEAD~1..HEAD
git commit -m "Revert to v0.1.0 state"
git push origin main

# In agora/ (private repo)
cd <path-to-agora-repo>
git revert --no-commit HEAD~1..HEAD
git commit -m "Revert to v0.1.0 state"
git push origin main
```

## Version Numbering Guidelines

Follow [Semantic Versioning](https://semver.org/):

- **Major (X.0.0)**: Breaking changes, incompatible API changes
- **Minor (0.X.0)**: New features, backward-compatible additions
- **Patch (0.0.X)**: Bug fixes, backward-compatible fixes

### Examples

- `v0.1.0` → `v0.2.0`: Added AI-powered narrative reports
- `v0.2.0` → `v0.2.1`: Fixed DynamoDB connection issue
- `v0.2.1` → `v1.0.0`: Changed authentication system (breaking)

## Troubleshooting

### "Repository not found" Error

Ensure you've created the GitHub repositories (Polis and Agora) and that you have access to both.

### Tag Already Exists

Delete the local tag and try again:
```bash
git tag -d v0.2.0
```

Or delete both local and remote:
```bash
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
```

### Uncommitted Changes

Commit or stash changes before releasing:
```bash
git stash
# or
git add .
git commit -m "Pre-release cleanup"
```

## Release Checklist

- [ ] All tests passing
- [ ] Documentation updated
- [ ] Both repos on `main` branch
- [ ] Working directory clean (no uncommitted changes)
- [ ] VERSION files updated
- [ ] Tags created and pushed
- [ ] GitHub shows both tags
- [ ] Paired release verified

## Architecture Note

Polis is designed as a standalone open-source platform (AGPL-3.0). Agora consumes Polis via its API as a proprietary application. The paired versioning ensures compatibility between the two systems while maintaining their architectural separation.

## See Also

- [Polis README](README.md)
- Agora README (in the Agora repository)
- Agora Release Process (documented in the Agora repository's RELEASING.md)
- [Semantic Versioning](https://semver.org/)
