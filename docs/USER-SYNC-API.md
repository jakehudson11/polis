# User Synchronization API

## Overview

The User Sync API allows external systems (like Agora) to synchronize users into Polis. This enables external applications to create or update Polis users based on their own user management systems.

## Endpoint

```http
POST /api/v3/users/sync
Content-Type: application/json
```

## Request

### Headers

```http
Content-Type: application/json
Authorization: Bearer <api-key>  # Optional: For server-to-server auth
```

### Body Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | User's email address (must be valid format) |
| `name` | string | No | User's display name |
| `external_id` | string | Yes | Unique identifier from external system |
| `external_system` | string | No | Name of external system (default: "agora") |

### Example Request

```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "external_id": "agora-user-12345",
  "external_system": "agora"
}
```

## Response

### Success (200 OK / 201 Created)

Returns `201 Created` if a new user was created, `200 OK` if an existing user was found.

```json
{
  "uid": 42,
  "email": "user@example.com",
  "created": true,
  "external_id": "agora-user-12345"
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `uid` | number | Polis user ID |
| `email` | string | User's email address |
| `created` | boolean | `true` if user was newly created, `false` if existing |
| `external_id` | string | The external ID from the request |

### Error Responses

#### 400 Bad Request

**Missing email:**
```json
{
  "error": "polis_err_user_sync_missing_email",
  "message": "Email is required"
}
```

**Missing external_id:**
```json
{
  "error": "polis_err_user_sync_missing_external_id",
  "message": "External ID is required"
}
```

**Invalid email format:**
```json
{
  "error": "polis_err_user_sync_invalid_email",
  "message": "Invalid email format"
}
```

#### 500 Internal Server Error

**General sync error:**
```json
{
  "error": "polis_err_user_sync_failed",
  "message": "User synchronization failed",
  "details": "Error details..."
}
```

## Behavior

### User Matching Logic

The API follows this logic to determine whether to create a new user or return an existing one:

1. **Check by External ID**: First checks if a user exists with the given `external_id`
   - If found, returns that user's `uid`
   - Updates user's name if provided

2. **Check by Email**: If no match by external ID, checks by email
   - If found, returns that user's `uid`
   - Creates XID mapping for the external ID
   - Updates name only if current name is empty

3. **Create New User**: If no match found
   - Creates new user with provided email and name
   - Generates random password hash (user won't use password auth)
   - Creates XID mapping for the external ID
   - Returns `created: true`

### Idempotency

The API is idempotent:
- Calling with the same `external_id` multiple times returns the same `uid`
- Calling with the same `email` creates an XID mapping if it doesn't exist
- Safe to call repeatedly without creating duplicate users

### Race Conditions

The API handles race conditions gracefully:
- If two requests try to create the same user simultaneously, one will succeed
- The other will detect the duplicate and fetch the newly created user
- Both requests return the same `uid`

## Implementation Details

### Database Tables Used

**users**
- Stores basic user information (email, name, password hash)

**xids**
- Stores external identity mappings
- Links `external_id` to Polis `uid`

### Registration in App

Add to `server/src/app.ts`:

```typescript
// Import
import { handle_POST_users_sync } from "./src/routes/userSync";

// Register route
app.post(
  "/api/v3/users/sync",
  moveToBody,
  handle_POST_users_sync
);
```

## Usage Example

### JavaScript/TypeScript

```typescript
const syncUser = async (email: string, externalId: string, name?: string) => {
  const response = await fetch('https://polis.example.com/api/v3/users/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,  // If using server-to-server auth
    },
    body: JSON.stringify({
      email,
      external_id: externalId,
      name,
      external_system: 'agora',
    }),
  });

  if (!response.ok) {
    throw new Error(`User sync failed: ${response.statusText}`);
  }

  const result = await response.json();
  return result.uid;
};

// Usage
try {
  const polisUid = await syncUser('user@example.com', 'agora-user-123', 'John Doe');
  console.log(`User synced with Polis UID: ${polisUid}`);
} catch (error) {
  console.error('Sync failed:', error);
}
```

### curl

```bash
curl -X POST https://polis.example.com/api/v3/users/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "email": "user@example.com",
    "name": "John Doe",
    "external_id": "agora-user-123",
    "external_system": "agora"
  }'
```

## Best Practices

### 1. Cache User Mappings

Store the `uid` → `external_id` mapping in your system to avoid unnecessary sync calls:

```typescript
// In Agora database
CREATE TABLE agora_users (
  id SERIAL PRIMARY KEY,
  polis_uid INTEGER NOT NULL UNIQUE,
  agora_user_id INTEGER NOT NULL,
  email TEXT,
  name TEXT,
  last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

// Before calling Polis API
const cachedUser = await agoraDB.query(
  'SELECT polis_uid FROM agora_users WHERE agora_user_id = $1',
  [agoraUserId]
);

if (cachedUser) {
  return cachedUser.polis_uid;
}

// If not cached, sync with Polis
const polisUid = await syncUser(email, externalId, name);

// Cache the mapping
await agoraDB.query(
  'INSERT INTO agora_users (polis_uid, agora_user_id, email, name) VALUES ($1, $2, $3, $4)',
  [polisUid, agoraUserId, email, name]
);
```

### 2. Sync on Demand

Sync users lazily (when they first interact with Polis features) rather than syncing all users upfront:

```typescript
const ensureUserInPolis = async (agoraUser: User) => {
  // Check cache first
  let polisUid = await getCachedPolisUid(agoraUser.id);
  
  if (!polisUid) {
    // Sync with Polis
    const result = await syncUser(
      agoraUser.email,
      `agora-${agoraUser.id}`,
      agoraUser.name
    );
    polisUid = result.uid;
    
    // Cache it
    await cachePolisUid(agoraUser.id, polisUid);
  }
  
  return polisUid;
};
```

### 3. Handle Errors Gracefully

Don't block user actions if sync fails:

```typescript
try {
  const polisUid = await syncUser(email, externalId, name);
  return polisUid;
} catch (error) {
  // Log error but don't fail the entire request
  logger.error('Failed to sync user to Polis', { error, email });
  
  // Optionally: queue for retry
  await queueUserSyncRetry(email, externalId, name);
  
  // Return cached UID if available, or null
  return await getCachedPolisUid(externalId) || null;
}
```

### 4. Use External ID Format Consistently

Use a consistent format for external IDs:

```typescript
// ✅ Good: Prefixed and namespaced
const externalId = `agora-user-${userId}`;
const externalId = `system:${systemName}:user:${userId}`;

// ❌ Avoid: Plain IDs (risk of collision with other systems)
const externalId = userId.toString();
```

## Security Considerations

### 1. Server-to-Server Authentication

Implement API key authentication for the sync endpoint:

```typescript
// In Polis app.ts
app.post(
  "/api/v3/users/sync",
  moveToBody,
  requireAPIKey,  // Add middleware to verify API key
  handle_POST_users_sync
);
```

### 2. Rate Limiting

Add rate limiting to prevent abuse:

```typescript
import rateLimit from 'express-rate-limit';

const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
});

app.post('/api/v3/users/sync', syncLimiter, handle_POST_users_sync);
```

### 3. Email Validation

Always validate email format server-side (already implemented in the endpoint).

### 4. PII Handling

Remember that email addresses are PII:
- Log only necessary information (not full email addresses)
- Comply with GDPR/privacy regulations
- Consider hashing emails in logs

## Testing

### Unit Tests

```typescript
describe('POST /api/v3/users/sync', () => {
  it('creates a new user with valid data', async () => {
    const response = await request(app)
      .post('/api/v3/users/sync')
      .send({
        email: 'test@example.com',
        name: 'Test User',
        external_id: 'test-123',
      });
      
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      email: 'test@example.com',
      created: true,
      external_id: 'test-123',
    });
    expect(response.body.uid).toBeDefined();
  });
  
  it('returns existing user on duplicate sync', async () => {
    // First sync
    const first = await request(app)
      .post('/api/v3/users/sync')
      .send({
        email: 'test@example.com',
        external_id: 'test-123',
      });
    
    // Second sync with same external_id
    const second = await request(app)
      .post('/api/v3/users/sync')
      .send({
        email: 'test@example.com',
        external_id: 'test-123',
      });
    
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.uid).toBe(first.body.uid);
  });
  
  it('rejects invalid email', async () => {
    const response = await request(app)
      .post('/api/v3/users/sync')
      .send({
        email: 'not-an-email',
        external_id: 'test-123',
      });
      
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('polis_err_user_sync_invalid_email');
  });
});
```

## Changelog

- 2026-02-02: Initial user sync API implementation
- Documented at: `docs/USER-SYNC-API.md`
