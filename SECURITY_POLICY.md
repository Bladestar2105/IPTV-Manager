# Security Policy - IPTV-Manager

## 🚨 CRITICAL SECURITY RULES

### NEVER COMMIT:
- ❌ **Test credentials** (TEST_CREDENTIALS.txt, *.credentials.txt)
- ❌ **Admin credentials** (ADMIN_CREDENTIALS.txt - delete locally after noting)
- ❌ **Provider credentials** (T-Rex, Xtream Codes, etc.)
- ❌ **Test data files** (test_setup.sh, comprehensive_test.sh)
- ❌ **Test reports** (FINAL_TEST_REPORT.md, TEST_REPORT_*.md)
- ❌ **Environment files** (.env, .env.local)
- ❌ **Database files** (db.sqlite, db.sqlite-wal, db.sqlite-shm)
- ❌ **Log files** (*.log, npm-debug.log*)

## 🔒 Git Configuration

### .gitignore Patterns
All critical files are blocked by `.gitignore`:
```
# Credentials
ADMIN_CREDENTIALS.txt
TEST_CREDENTIALS.txt
*.credentials.txt
*test*.txt
*_test_*.txt

# Test data
test_setup.sh
comprehensive_test.sh
FINAL_TEST_REPORT.md
TEST_REPORT_v3.0.0.md

# Database
db.sqlite
db.sqlite-wal
db.sqlite-shm

# Environment
.env
.env.local

# Logs
*.log
npm-debug.log*
```

## ✅ SAFE TO COMMIT:
- ✅ Source code (*.js, *.html, *.css, *.json)
- ✅ User documentation (README.md, CHANGELOG.md, BRANCH_STATUS.md)
- ✅ Configuration templates (.env.example)
- ✅ License files
- ✅ Package files (package.json, package-lock.json)

## 🛡️ Testing Without Exposing Credentials

### Local Testing
```bash
# Create local test file (NOT committed)
TEST_CREDENTIALS.txt
# Add to .gitignore (already done)
# Use for local testing only
# NEVER commit this file
```

### Safe Testing
```bash
# Test with dummy data
provider: "Test Provider"
username: "testuser"
password: "testpass"

# Or use your own test provider
# NEVER use real production credentials in tests
```

## 📋 Pre-Commit Checklist

Before pushing, verify:

```bash
# Check for credentials
git status | grep -i credential
# If any credential files appear, ABORT!

# Check for test files
git status | grep -i test
# If any test files appear, ABORT!

# Check git diff for secrets
git diff | grep -i "password\|secret\|token\|credential"
# If any secrets appear, ABORT!
```

## 🚨 Incident Response

### If Credentials Were Accidentally Committed:

1. **IMMEDIATE ACTION:**
   ```bash
   # Reset last commit
   git reset --hard HEAD~1
   
   # Force push to remove from remote
   git push --force
   ```

2. **If Credentials Are in Git History:**
   ```bash
   # REWRITE ENTIRE HISTORY (extreme measure)
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch FILE_NAME" \
     --prune-empty --tag-name-filter cat -- --all
   
   # Force push all branches
   git push --force --all
   ```

3. **Rotate All Exposed Credentials:**
   - Change all passwords immediately
   - Regenerate JWT secrets
   - Notify all users of potential breach

## 🔍 Code Review Security Checks

Reviewers should check for:

- ❌ Hardcoded credentials in code
- ❌ API keys in commits
- ❌ Database connection strings with passwords
- ❌ Provider URLs with credentials
- ❌ Test data with real user information

## 📧 Reporting Security Issues

If you discover a security vulnerability:

1. **DO NOT** create a public issue
2. **DO** email the maintainers privately
3. **DO** provide detailed steps to reproduce
4. **DO** wait for confirmation before disclosure

## 🎯 Best Practices

### Development
- Use environment variables for all secrets
- Create `.env.example` with dummy values
- Never hardcode credentials in source code
- Use `.gitignore` for all sensitive files

### Testing
- Use mock/dummy data for tests
- Never commit test credentials
- Keep test data in separate directory (ignored)
- Delete test reports before pushing

### Documentation
- Document security procedures
- Keep security policies up to date
- Train team members on security practices

## 📌 Reminders

⚠️ **Test credentials (T-Rex, etc.) MUST NEVER be committed to Git!**  
⚠️ **This is a CRITICAL security risk that must be avoided at all costs!**  
⚠️ **Always double-check git status before pushing!**  
⚠️ **Review git diff for any sensitive data!**  

---

**Remember:** Security is everyone's responsibility. When in doubt, don't commit it!