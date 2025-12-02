#!/bin/bash

# Bash script to run user migration
# Usage: ./run-migration.sh

PROJECT_ID="truepay-72060"
REGION="us-central1"
FUNCTION_NAME="migrateUsersHttp"

URL="https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}/migrateUsers"

echo "🚀 Starting user migration..."
echo "📡 Calling: $URL"
echo ""

response=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$URL")

if [ $? -eq 0 ]; then
  echo "✅ Migration completed!"
  echo ""
  echo "📊 Results:"
  echo "$response" | jq '.'
  
  success=$(echo "$response" | jq -r '.success')
  if [ "$success" = "true" ]; then
    updated=$(echo "$response" | jq -r '.updatedUsers')
    total=$(echo "$response" | jq -r '.totalUsers')
    skipped=$(echo "$response" | jq -r '.skippedUsers')
    
    echo ""
    echo "✨ Successfully migrated $updated out of $total users"
    if [ "$skipped" -gt 0 ]; then
      echo "ℹ️  $skipped users already had all fields"
    fi
    exit 0
  else
    echo ""
    echo "❌ Migration failed"
    exit 1
  fi
else
  echo "❌ Request failed"
  exit 1
fi

