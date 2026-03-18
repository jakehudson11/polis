import type { ExpressResponse, RequestWithP } from "../d";
import pg from "../db/pg-query";
import { failJson } from "../utils/fail";
import { isModerator } from "../utils/common";
import { createPaginationMeta, parsePagination } from "../utils/pagination";

type SortKey =
  | "votes_desc"
  | "votes_asc"
  | "comments_desc"
  | "comments_asc"
  | "pid_asc"
  | "pid_desc";

const SORT_SQL: Record<SortKey, string> = {
  votes_desc: "ps.votes DESC, ps.comments DESC, ps.pid ASC",
  votes_asc: "ps.votes ASC, ps.comments DESC, ps.pid ASC",
  comments_desc: "ps.comments DESC, ps.votes DESC, ps.pid ASC",
  comments_asc: "ps.comments ASC, ps.votes DESC, ps.pid ASC",
  pid_asc: "ps.pid ASC",
  pid_desc: "ps.pid DESC",
};

function normalizeSort(sort?: string): SortKey {
  const normalized = (sort || "votes_desc") as SortKey;
  if (SORT_SQL[normalized]) {
    return normalized;
  }
  return "votes_desc";
}

interface ConversationSummaryRequest extends RequestWithP {
  p: {
    zid: number;
    uid?: number;
  };
}

interface ParticipationStatsRequest extends RequestWithP {
  p: {
    zid: number;
    uid?: number;
    limit?: number;
    offset?: number;
    sort?: string;
    q?: string;
  };
}

type ConversationSummaryRow = {
  participants_voted: string | number;
  total_votes: string | number;
  commenters: string | number;
  total_comments: string | number;
  total_statements: string | number;
  avg_votes_per_participant: string | number;
};

type TotalRow = {
  total: string | number;
};

type ParticipationRow = {
  pid: string | number;
  xid: string | null;
  email: string | null;
  votes: string | number;
  comments: string | number;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function ensureModerator(
  zid: number,
  uid: number | undefined,
  res: ExpressResponse,
  errorCode: string
): Promise<boolean> {
  if (!uid) {
    failJson(res, 401, `${errorCode}_authentication_required`);
    return false;
  }

  const isMod = await isModerator(zid, uid);
  if (!isMod) {
    failJson(res, 403, `${errorCode}_not_authorized`);
    return false;
  }

  return true;
}

export async function handle_GET_conversationSummary(
  req: ConversationSummaryRequest,
  res: ExpressResponse
): Promise<void> {
  const { zid, uid } = req.p;

  try {
    const isAllowed = await ensureModerator(
      zid,
      uid,
      res,
      "polis_err_get_conversationSummary"
    );
    if (!isAllowed) {
      return;
    }

    const rows = asArray<ConversationSummaryRow>(
      await pg.queryP_readOnly(
      `WITH vote_stats AS (
         SELECT
           COUNT(DISTINCT pid)::int AS participants_voted,
           COUNT(*)::int AS total_votes
         FROM votes_latest_unique
         WHERE zid = ($1)
       ),
       comment_stats AS (
         SELECT
           COUNT(DISTINCT pid)::int AS commenters,
           COUNT(*)::int AS total_comments
         FROM comments
         WHERE zid = ($1)
           AND active = true
           AND mod != -1
           AND COALESCE(is_seed, false) = false
       ),
       statement_stats AS (
         SELECT
           COUNT(*)::int AS total_statements
         FROM comments
         WHERE zid = ($1)
           AND active = true
           AND mod != -1
       )
       SELECT
         vote_stats.participants_voted,
         vote_stats.total_votes,
         CASE
           WHEN vote_stats.participants_voted = 0 THEN 0
           ELSE vote_stats.total_votes::float / vote_stats.participants_voted
         END AS avg_votes_per_participant,
         comment_stats.commenters,
         comment_stats.total_comments,
         statement_stats.total_statements
       FROM vote_stats, comment_stats, statement_stats;`,
      [zid]
      )
    );

    const summary = rows?.[0] || {
      participants_voted: 0,
      total_votes: 0,
      avg_votes_per_participant: 0,
      commenters: 0,
      total_comments: 0,
      total_statements: 0,
    };

    res.status(200).json({
      participants_voted: Number(summary.participants_voted) || 0,
      total_votes: Number(summary.total_votes) || 0,
      avg_votes_per_participant: Number(summary.avg_votes_per_participant) || 0,
      commenters: Number(summary.commenters) || 0,
      total_comments: Number(summary.total_comments) || 0,
      total_statements: Number(summary.total_statements) || 0,
    });
  } catch (err) {
    failJson(res, 500, "polis_err_get_conversationSummary", err);
  }
}

export async function handle_GET_participationStats(
  req: ParticipationStatsRequest,
  res: ExpressResponse
): Promise<void> {
  const { zid, uid } = req.p;

  try {
    const isAllowed = await ensureModerator(
      zid,
      uid,
      res,
      "polis_err_get_participationStats"
    );
    if (!isAllowed) {
      return;
    }

    const pagination = parsePagination(
      { limit: req.p.limit, offset: req.p.offset },
      { defaultLimit: 50, maxLimit: 500 }
    );
    const sortKey = normalizeSort(req.p.sort);
    const orderClause = SORT_SQL[sortKey];
    const queryFilter =
      typeof req.p.q === "string" && req.p.q.trim().length > 0
        ? `%${req.p.q.trim()}%`
        : null;

    const totalRows = asArray<TotalRow>(
      await pg.queryP_readOnly(
      `WITH vote_counts AS (
         SELECT pid, COUNT(*)::int AS votes
         FROM votes_latest_unique
         WHERE zid = ($1)
         GROUP BY pid
       ),
       comment_counts AS (
         SELECT pid, COUNT(*)::int AS comments
         FROM comments
         WHERE zid = ($1)
           AND active = true
           AND mod != -1
           AND COALESCE(is_seed, false) = false
         GROUP BY pid
       ),
       participant_stats AS (
         SELECT
           COALESCE(v.pid, c.pid) AS pid,
           COALESCE(v.votes, 0)::int AS votes,
           COALESCE(c.comments, 0)::int AS comments
         FROM vote_counts v
         FULL OUTER JOIN comment_counts c ON c.pid = v.pid
       )
       , participant_with_user AS (
         SELECT
           ps.pid,
           u.email
         FROM participant_stats ps
         LEFT JOIN participants p
           ON p.zid = ($1) AND p.pid = ps.pid
         LEFT JOIN users u
           ON u.uid = p.uid
       )
       SELECT COUNT(*)::int AS total
       FROM participant_with_user pw
       WHERE (
         ($2)::text IS NULL
         OR pw.pid::text ILIKE ($2)
         OR COALESCE(pw.email, '') ILIKE ($2)
       );`,
      [zid, queryFilter]
      )
    );

    const total = Number(totalRows?.[0]?.total) || 0;

    const participantRows = asArray<ParticipationRow>(
      await pg.queryP_readOnly(
      `WITH owner_row AS (
         SELECT owner FROM conversations WHERE zid = ($1)
       ),
       vote_counts AS (
         SELECT pid, COUNT(*)::int AS votes
         FROM votes_latest_unique
         WHERE zid = ($1)
         GROUP BY pid
       ),
       comment_counts AS (
         SELECT pid, COUNT(*)::int AS comments
         FROM comments
         WHERE zid = ($1)
           AND active = true
           AND mod != -1
           AND COALESCE(is_seed, false) = false
         GROUP BY pid
       ),
       participant_stats AS (
         SELECT
           COALESCE(v.pid, c.pid) AS pid,
           COALESCE(v.votes, 0)::int AS votes,
           COALESCE(c.comments, 0)::int AS comments
         FROM vote_counts v
         FULL OUTER JOIN comment_counts c ON c.pid = v.pid
       )
       SELECT
         ps.pid,
         x.xid,
         u.email,
         ps.votes,
         ps.comments
       FROM participant_stats ps
       LEFT JOIN participants p
         ON p.zid = ($1) AND p.pid = ps.pid
       LEFT JOIN users u
         ON u.uid = p.uid
       LEFT JOIN owner_row o ON true
       LEFT JOIN (
         SELECT DISTINCT ON (uid, owner) uid, owner, xid
         FROM xids
         ORDER BY uid, owner, created
       ) x ON x.uid = p.uid AND x.owner = o.owner
       WHERE (
         ($2)::text IS NULL
         OR ps.pid::text ILIKE ($2)
         OR COALESCE(u.email, '') ILIKE ($2)
       )
       ORDER BY ${orderClause}
       LIMIT ($3) OFFSET ($4);`,
      [zid, queryFilter, pagination.limit, pagination.offset]
      )
    );

    const paginationMeta = createPaginationMeta(
      pagination.limit,
      pagination.offset,
      total
    );

    res.status(200).json({
      participants: participantRows.map((row) => ({
        pid: Number(row.pid),
        xid: row.xid ?? null,
        email: row.email ?? null,
        votes: Number(row.votes) || 0,
        comments: Number(row.comments) || 0,
      })),
      pagination: {
        limit: paginationMeta.limit,
        offset: paginationMeta.offset,
        total: paginationMeta.total || 0,
        has_next: Boolean(paginationMeta.hasMore),
      },
    });
  } catch (err) {
    failJson(res, 500, "polis_err_get_participationStats", err);
  }
}
