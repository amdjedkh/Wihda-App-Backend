#!/bin/bash

# Wihda Backend API Test Script
# Tests all endpoints against local development server

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_VERSION="v1"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Store auth token
TOKEN=""

echo "=== Wihda Backend API Tests ==="
echo "Base URL: $BASE_URL"
echo ""

# Test health endpoint
test_health() {
    echo -n "Testing health endpoint... "
    response=$(curl -s -w "\n%{http_code}" "$BASE_URL/health")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
        echo "  Response: $body"
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
    fi
}

# Test signup
test_signup() {
    echo -n "Testing signup... "
    response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/$API_VERSION/auth/signup" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"test@example.com\",\"password\":\"password123\",\"display_name\":\"Test User\"}")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
        # Extract token
        TOKEN=$(echo "$body" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
        echo "  Token obtained: ${TOKEN:0:20}..."
    else
        echo -e "${YELLOW}⚠ SKIP${NC} (may already exist)"
    fi
}

# Test login
test_login() {
    echo -n "Testing login... "
    response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/$API_VERSION/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"test@example.com\",\"password\":\"password123\"}")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
        TOKEN=$(echo "$body" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
    fi
}

# Test get profile
test_profile() {
    echo -n "Testing get profile... "
    if [ -z "$TOKEN" ]; then
        echo -e "${YELLOW}⚠ SKIP${NC} (no token)"
        return
    fi
    
    response=$(curl -s -w "\n%{http_code}" "$BASE_URL/$API_VERSION/me" \
        -H "Authorization: Bearer $TOKEN")
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
    fi
}

# Test neighborhood lookup
test_neighborhood_lookup() {
    echo -n "Testing neighborhood lookup... "
    response=$(curl -s -w "\n%{http_code}" "$BASE_URL/$API_VERSION/neighborhoods/lookup?city=Rabat")
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
    fi
}

# Test create offer
test_create_offer() {
    echo -n "Testing create offer... "
    if [ -z "$TOKEN" ]; then
        echo -e "${YELLOW}⚠ SKIP${NC} (no token)"
        return
    fi
    
    response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/$API_VERSION/leftovers/offers" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
            "title": "Test Offer",
            "description": "Test description",
            "survey": {
                "food_type": "cooked_meal",
                "diet_constraints": ["halal"],
                "portions": 4,
                "pickup_time_preference": "evening",
                "distance_willing_km": 5
            },
            "expiry_hours": 24
        }')
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
        echo "  Response: $body"
    fi
}

# Test OpenAPI spec
test_openapi() {
    echo -n "Testing OpenAPI spec... "
    response=$(curl -s -w "\n%{http_code}" "$BASE_URL/openapi.json")
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASS${NC}"
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
    fi
}

# Run all tests
run_tests() {
    echo "Running tests..."
    echo ""
    
    test_health
    test_signup
    test_login
    test_profile
    test_neighborhood_lookup
    test_create_offer
    test_openapi
    
    echo ""
    echo "=== Tests Complete ==="
}

# Check if server is running
check_server() {
    echo -n "Checking if server is running... "
    if curl -s --connect-timeout 2 "$BASE_URL/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Server is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Server is not running${NC}"
        echo "  Start with: npm run dev"
        return 1
    fi
}

# Main
if check_server; then
    run_tests
fi
