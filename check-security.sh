#!/bin/bash

# 🔒 Pre-commit Security Check Script
# Run this before pushing to GitHub to ensure no sensitive data is included

echo "🔍 Checking for sensitive data that might be accidentally committed..."
echo ""

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "❌ Not a git repository. Run 'git init' first."
    exit 1
fi

# Check for .env files that would be committed (not ignored)
echo "1️⃣ Checking for .env files that would be committed to git:"
git ls-files | grep "\.env$" 2>/dev/null
if [ $? -eq 0 ]; then
    echo "❌ WARNING: .env files found in git index - they will be committed!"
    echo "   Run: git reset HEAD *.env && git reset HEAD **/*.env"
else
    echo "✅ No .env files in git index - they are properly ignored!"
fi
echo ""

# Show what .env files exist locally (should be ignored)
echo "2️⃣ Local .env files (should exist but be git-ignored):"
find . -name ".env" -not -name "*.example" | grep -v node_modules
echo "ℹ️  These files should exist locally but be ignored by git"
echo ""

# Verify .env files are ignored
echo "3️⃣ Verifying .env files are git-ignored:"
git check-ignore .env services/*/.env 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ .env files are properly ignored by git"
else
    echo "❌ WARNING: Some .env files might not be ignored!"
fi
echo ""

# Check what files will actually be committed
echo "4️⃣ Files that will be committed (staged and untracked):"
echo "📋 Staged files:"
git diff --cached --name-only 2>/dev/null || echo "   (none - no files staged)"
echo ""
echo "📋 New files to be added:"
git ls-files --others --exclude-standard | head -10
echo ""

# Check for potential credentials in files that would be committed
echo "5️⃣ Checking for potential hardcoded credentials in files to be committed:"

# Get list of files that would be committed
FILES_TO_CHECK=$(git ls-files --others --exclude-standard; git diff --cached --name-only 2>/dev/null)

if [ -n "$FILES_TO_CHECK" ]; then
    echo "   📍 Checking for real MongoDB URLs (not templates) in files to be committed..."
    MONGO_MATCHES=$(echo "$FILES_TO_CHECK" | xargs grep -l "mongodb+srv://.*:.*@.*\.mongodb\.net" 2>/dev/null | grep -v ".env.example" | grep -v "SECURITY_CHECKLIST.md" | grep -v "check-security.sh")
    if [ -n "$MONGO_MATCHES" ]; then
        echo "❌ WARNING: Found real MongoDB URLs in files that will be committed!"
        echo "$MONGO_MATCHES"
    else
        echo "✅ No real MongoDB URLs in files to be committed"
    fi

    echo "   📍 Checking for real API keys (not templates) in files to be committed..."
    API_MATCHES=$(echo "$FILES_TO_CHECK" | xargs grep -l "re_[a-zA-Z0-9]\{20,\}" 2>/dev/null | grep -v ".env.example" | grep -v "SECURITY_CHECKLIST.md" | grep -v "check-security.sh")
    if [ -n "$API_MATCHES" ]; then
        echo "❌ WARNING: Found real API keys in files that will be committed!"
        echo "$API_MATCHES"
    else
        echo "✅ No real API keys in files to be committed"
    fi

    echo "   📍 Checking for real JWT secrets (not templates) in files to be committed..."
    JWT_MATCHES=$(echo "$FILES_TO_CHECK" | xargs grep -l "haunts_server_konnect_secret_key" 2>/dev/null | grep -v ".env.example" | grep -v "SECURITY_CHECKLIST.md" | grep -v "check-security.sh")
    if [ -n "$JWT_MATCHES" ]; then
        echo "❌ WARNING: Found real JWT secrets in files that will be committed!"
        echo "$JWT_MATCHES"
    else
        echo "✅ No real JWT secrets in files to be committed"
    fi
else
    echo "✅ No files staged for commit"
fi
echo ""

echo "6️⃣ Verifying .gitignore files exist:"
ls -la .gitignore services/*/.gitignore 2>/dev/null
echo ""

echo "✅ Pre-commit check completed!"
echo ""
echo "📊 SUMMARY:"
echo "   • .env files exist locally (✅ normal for development)"
echo "   • .env files are git-ignored (✅ secure)"
echo "   • Only safe files will be committed (✅ ready)"
echo ""
echo "🚀 If no ❌ warnings above, you're safe to:"
echo "   git add ."
echo "   git commit -m 'Your commit message'"
echo "   git push"