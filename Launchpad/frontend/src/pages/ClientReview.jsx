import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, ExternalLink, Loader2, MessageSquare, ThumbsUp, PenLine } from 'lucide-react';

/**
 * The client review page.
 *
 * Reached from an emailed link, with no login and no account. It is deliberately
 * plain: the reader is a client on a phone, not an engineer. It uses plain fetch
 * rather than the shared axios client, because that one carries the admin
 * session, the CSRF dance and a redirect to /login on a 401, none of which
 * belong on a public page.
 *
 * Everything shown here comes from the one shop the token points at. Comment
 * text is rendered as text, never as markup.
 */

function apiPath(token, suffix = '') {
  return `/api/review/${encodeURIComponent(token)}${suffix}`;
}

async function readError(res) {
  try {
    const data = await res.json();
    return data?.error?.message || 'Something went wrong. Please try again.';
  } catch {
    return 'Something went wrong. Please try again.';
  }
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function ClientReview() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [target, setTarget] = useState('general:');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(apiPath(token), { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return res.json();
      })
      .then((payload) => { if (!cancelled) { setData(payload); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setLoadError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token]);

  const submitComment = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const body = comment.trim();
    if (!body) return;
    const sep = target.indexOf(':');
    const targetType = target.slice(0, sep);
    const targetRef = target.slice(sep + 1);

    setSending(true);
    try {
      const res = await fetch(apiPath(token, '/comment'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_type: targetType, target_ref: targetRef, body, author_name: name.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = await res.json();
      setData((d) => ({ ...d, comments: [...(d?.comments || []), payload.comment] }));
      setComment('');
      setNotice('Your comment was saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const decide = async (decision) => {
    setError('');
    setNotice('');
    if (!name.trim()) {
      setError('Please put your name in the box above the buttons first.');
      return;
    }
    setDeciding(decision);
    try {
      const res = await fetch(apiPath(token, '/decision'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, name: name.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = await res.json();
      setData((d) => ({ ...d, status: payload.status, decided_at: payload.decided_at, decided_by_name: payload.decided_by_name }));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeciding('');
    }
  };

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your review page
        </div>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">This link does not work</h1>
        <p className="text-sm text-slate-600 leading-relaxed">{loadError}</p>
      </Shell>
    );
  }

  const answered = data.status !== 'pending';

  return (
    <Shell>
      <p className="text-xs uppercase tracking-widest text-slate-400 mb-1">Site review</p>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">{data.shop.name}</h1>
      <p className="text-sm text-slate-500 mb-5">
        This is a test site. Please do not place orders on it.
      </p>

      <a
        href={data.shop.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white mb-6"
      >
        Open the site
        <ExternalLink className="h-4 w-4" />
      </a>

      {data.note && (
        <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700 leading-relaxed mb-6">
          {data.note}
        </p>
      )}

      {answered && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 mb-6">
          <p className="text-sm font-medium text-emerald-900">
            {data.status === 'approved' ? 'You approved this site.' : 'You asked for changes to this site.'}
          </p>
          <p className="text-xs text-emerald-800 mt-1">
            {data.decided_by_name}, {formatDate(data.decided_at)}. We have your answer, so there is nothing more to do here.
          </p>
        </div>
      )}

      <section className="mb-7">
        <h2 className="text-sm font-semibold text-slate-900 mb-2">What to look at</h2>
        <ul className="space-y-2">
          {data.checklist.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-slate-600 leading-relaxed">
              <Check className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
              {line}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-7">
        <h2 className="text-sm font-semibold text-slate-900 mb-1">Leave a comment</h2>
        <p className="text-xs text-slate-500 mb-3">
          Pick the page or the product it is about, then tell us what needs to change.
        </p>
        <form onSubmit={submitComment} className="space-y-3">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={answered}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 disabled:bg-slate-100"
          >
            <option value="general:">The site in general</option>
            <optgroup label="Pages">
              {data.pages.map((p) => (
                <option key={p.ref} value={`page:${p.ref}`}>{p.label}</option>
              ))}
            </optgroup>
            {data.products.length > 0 && (
              <optgroup label="Products">
                {data.products.map((p) => (
                  <option key={p.ref} value={`product:${p.ref}`}>{p.collection}: {p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={4}
            disabled={answered}
            placeholder="What needs to change?"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 disabled:bg-slate-100"
          />
          <button
            type="submit"
            disabled={sending || answered || !comment.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            Add comment
          </button>
        </form>
      </section>

      {data.comments.length > 0 && (
        <section className="mb-7">
          <h2 className="text-sm font-semibold text-slate-900 mb-2">
            Your comments so far ({data.comments.length})
          </h2>
          <ul className="space-y-2">
            {data.comments.map((c) => (
              <li key={c.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">
                  {c.target_ref || 'The site in general'}
                </p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{c.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!answered && (
        <section className="border-t border-slate-200 pt-6">
          <h2 className="text-sm font-semibold text-slate-900 mb-1">Your answer</h2>
          <p className="text-xs text-slate-500 mb-3">
            Approving tells us the site is right. It does not put the site live on its own. We do that after you approve.
          </p>
          <label className="block text-xs font-medium text-slate-600 mb-1">Your name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="First and last name"
            className="mb-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => decide('approved')}
              disabled={!!deciding}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {deciding === 'approved' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
              Approve
            </button>
            <button
              type="button"
              onClick={() => decide('changes_requested')}
              disabled={!!deciding}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 disabled:opacity-50"
            >
              {deciding === 'changes_requested' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
              Request changes
            </button>
          </div>
        </section>
      )}

      {notice && <p className="mt-4 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

      <p className="mt-8 text-xs text-slate-400">
        This link works until {formatDate(data.expires_at)}. LR Paris.
      </p>
    </Shell>
  );
}

// A plain white page of its own, so nothing here depends on the Launchpad
// theme, the header or a signed in user.
function Shell({ children }) {
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto w-full max-w-lg px-5 py-10">{children}</div>
    </div>
  );
}
