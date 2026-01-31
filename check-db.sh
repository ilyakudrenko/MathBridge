#!/bin/bash

# Helper script to check the database

echo "=== Database Users ==="
sqlite3 database.sqlite -header -column "SELECT id, email, firstName, lastName, phone, createdAt FROM users;"

echo ""
echo "=== Total Users ==="
sqlite3 database.sqlite "SELECT COUNT(*) as total FROM users;"

echo ""
echo "=== Table Structure ==="
sqlite3 database.sqlite ".schema users"



