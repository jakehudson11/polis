# Polis - Open Source Real-Time Democratic Input

Polis is an AI-powered real-time system for gathering, analyzing and understanding what large groups of people think in their own words, enabled by advanced statistics and machine learning.

## Modifications & Upstream Attribution

This repository is a **modified version** of [Polis](https://github.com/compdemocracy/polis), the open-source deliberation platform by the Computational Democracy Project. Modifications include:

- **Server** (TypeScript): complete port of the upstream Clojure server to TypeScript/Node.js (a derivative work of the original)
- **Delphi** (Python): new Python implementation of the Delphi analysis service (the upstream is Clojure)
- **AI extensions**: seed comment generation, AI provider routing, AI usage logging, agora LLM proxy integration, and related migrations
- **Client-Participation-Alpha**: fork additions including XID external identifiers, topic-agenda UI, and centralized JWT handling

Polis is licensed under AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## What is Polis?

Polis is a platform for gathering feedback and opinions from large groups. It uses conversation clustering algorithms to identify emergent consensus and disagreement patterns among participants. The platform has been used around the world by governments, civic groups, and organizations for:

- Civic engagement and consultation
- Community discussions
- Policy deliberation
- Opinion research

## Core Features

- **Real-time voting**: Participants vote on statements (agree/disagree/pass)
- **Intelligent comment selection**: Machine learning selects comments to maximize information gain
- **Opinion clustering**: PCA-based clustering reveals opinion groups
- **Group visualization**: Interactive visualizations show opinion landscapes
- **AI Extensions**: 
  - Seed comment generation (OpenAI integration)
  - Delphi analysis (creates groups, titles, spatial maps)

## Architecture

Polis consists of several services:

- **Server** (Node.js/TypeScript): Core API for conversations, comments, and votes
- **Math** (Clojure): PCA-based clustering and statistical analysis  
- **Delphi** (Python): AI-powered analysis, group creation, spatial visualizations
- **Client-Admin**: Admin dashboard for conversation management
- **Client-Participation**: Public-facing voting interface
- **Client-Participation-Alpha**: Next-generation participation UI
- **Client-Report**: Report generation and visualization

## Getting Started

### Prerequisites

- Docker & Docker Compose
- PostgreSQL database
- (Optional) OpenAI API key for seed comment generation
- (Optional) Anthropic API key for Delphi AI analysis

### Quick Start

1. **Clone the repository**
```bash
git clone https://github.com/jakehudson11/polis.git
cd polis
```

2. **Configure environment**
```bash
cp example.env .env
# Edit .env with your configuration
```

3. **Start services**
```bash
docker-compose up
```

> **Note**: `docker compose up` starts the API-only stack. Add `docker compose --profile clients up` to also run the four web client UIs (client-admin, client-participation, client-participation-alpha, client-report).

4. **Access the platform**
- API: http://localhost:5000
- Admin: http://localhost:8080

## API Documentation

### Core Endpoints

**Conversations**
- `POST /api/v3/conversations` - Create conversation
- `GET /api/v3/conversations/:id` - Get conversation
- `PUT /api/v3/conversations/:id` - Update conversation

**Comments & Voting**
- `POST /api/v3/comments` - Submit comment
- `GET /api/v3/comments` - Get comments
- `POST /api/v3/votes` - Submit vote
- `GET /api/v3/nextComment` - Get next comment for voting

**Analysis**
- `GET /api/v3/math/pca2` - Get clustering analysis
- `GET /api/v3/delphi/*` - Delphi analysis endpoints

**AI Extensions (Optional)**
- `POST /api/v3/conversations/:id/seed-comments/generate` - Generate seed comments
- `POST /api/v3/conversations/:id/seed-comments/submit` - Submit seed comments

### Authentication

Polis uses JWT tokens for authentication. Obtain a token by authenticating with your user credentials:

```bash
POST /api/v3/auth/token
{
  "email": "user@example.com",
  "password": "password"
}
```

## Configuration

### Environment Variables

**Core Polis**
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/polis
POLIS_JWT_SECRET=your-secret-key
POLIS_INTERNAL_PROXY_SECRET=your-internal-proxy-secret
```

`POLIS_INTERNAL_PROXY_SECRET` enables a trusted proxy (for example, Agora backend)
to pass `x-polis-uid` headers for server-to-server requests. Keep this secret and
only set it when you control the proxy.

**AI Services (Optional)**
```bash
OPENAI_API_KEY=sk-...  # For seed comment generation
ANTHROPIC_API_KEY=sk-ant-...  # For Delphi AI analysis
```

**Internal Services**
```bash
MATH_SERVICE_URL=http://math:8080
DELPHI_SERVICE_URL=http://delphi:8000
```

## Database

Polis uses PostgreSQL with the following core tables:

- `conversations` - Conversation metadata
- `comments` - User comments (includes `is_seed` flag for AI-generated comments)
- `votes` - Participant votes
- `participants` - Conversation participants
- `users` - User accounts
- `math_*` - Clustering and analysis cache
- `reports` - Generated reports
- `topic_agenda_selections` - Topic prioritization (Delphi)

### Running Migrations

```bash
cd server
npm run migrate
```

## Development

### Local Development Setup

1. **Install dependencies**
```bash
# Server
cd server && npm install

# Math (requires Clojure)
cd math && clojure -X:deps prep

# Delphi (requires Python 3.11+)
cd delphi && pip install -r requirements.lock

# Client applications
cd client-admin && npm install
cd client-participation && npm install
cd client-participation-alpha && npm install
```

2. **Run services locally**
```bash
# Server
cd server && npm run dev

# Math
cd math && ./bin/run

# Delphi
cd delphi && python start_poller.py
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment guidelines.

## Architecture & Separation

Polis is designed to be a standalone platform that can be consumed by proprietary applications (like Agora) via its API. This separation ensures:

- **Clean licensing**: Polis remains AGPL-3.0 open source
- **Modularity**: Polis can be deployed independently or integrated with other systems
- **API-first design**: All functionality is accessible via documented REST APIs

For details on how Agora integrates with Polis while maintaining separation, see:

- Agora and Polis run as separate services communicating only over HTTP/JSON; they share no code and no database.
- [User Sync API](docs/USER-SYNC-API.md) - How external systems can sync users with Polis

## Releases & Versioning

Polis and Agora use synchronized versioning for paired releases.

- **Current Version**: See [VERSION](VERSION) file
- **Release Process**: See [RELEASING.md](RELEASING.md)
- **Rollback Guide**: See [RELEASING.md](RELEASING.md#rolling-back-to-a-previous-version)

## License

Polis is licensed under AGPL-3.0. See [LICENSE](LICENSE) for details.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Community

- **Website**: https://pol.is
- **GitHub**: https://github.com/compdemocracy/polis
- **Discord**: [Join our community](https://discord.gg/polis)

## Citation

If you use Polis in academic work, please cite:

```
@software{polis2024,
  title = {Polis: Real-Time Democratic Input Platform},
  author = {Computational Democracy Project},
  year = {2024},
  url = {https://github.com/compdemocracy/polis}
}
```

## Acknowledgments

Polis is maintained by the Computational Democracy Project and contributors worldwide.
