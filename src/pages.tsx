import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useFeltKit, useMutation, useQueryState, useSession } from "@feltdb/feltkit/react";
import { Bell, Camera, Compass, ImagePlus, Search, Trash2, X } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import { Byline, Empty, EmptyGridIcon, Failure, FollowButton, Grid, LikeButton, PersonRow, PostCard, Spinner, useLike, type Tile } from "./components";
import { Avatar, Link, Photo, ago, navigate, plural, prepareImage, useSentinel } from "./lib";
import { ThemeToggle } from "./theme";

type Me = { id: string; username: string; displayName: string; avatarFileId?: string };

// ── Home ───────────────────────────────────────────────────────────────────────────────────
/** One page of the feed, live. Pages are chained by the cursor each one returns. */
function FeedSegment({ cursor, onNext }: { cursor?: number; onNext: (next: number | null) => void }) {
  const page = useQueryState(api.posts.feed, cursor === undefined ? { limit: 8 } : { cursor, limit: 8 });
  useEffect(() => void (page.data && onNext(page.data.nextCursor)), [page.data?.nextCursor, page.data !== undefined]);
  if (page.error) return <Failure error={page.error} />;
  if (!page.data) return <Spinner />;
  return <>{page.data.posts.map((p) => <PostCard key={p.id} post={p} />)}</>;
}

export function Home() {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const first = useQueryState(api.posts.feed, { limit: 8 });
  const more = () => next != null && !cursors.includes(next) && setCursors((c) => [...c, next]);
  const sentinel = useSentinel(more, next != null);
  const empty = first.data && first.data.posts.length === 0;
  return (
    <div className="feed-layout">
      <div className="feed">
        {empty ? (
          <Empty icon={<Camera size={30} strokeWidth={1.4} />} title="Your feed is quiet">
            Follow people to see their photos here, or share your first one.
          </Empty>
        ) : (
          cursors.map((c, i) => <FeedSegment key={c ?? "top"} cursor={c} onNext={(n) => i === cursors.length - 1 && setNext(n)} />)
        )}
        <div ref={sentinel} />
        {empty && <Suggestions title="Suggested for you" />}
      </div>
      <aside className="rail">
        <Suggestions title="Suggested for you" compact />
      </aside>
    </div>
  );
}

function Suggestions({ title, compact }: { title: string; compact?: boolean }) {
  const people = useQueryState(api.profiles.suggested, { limit: compact ? 5 : 8 });
  if (!people.data?.length) return null;
  return (
    <section className={`suggestions ${compact ? "compact" : ""}`}>
      <h2 className="section-title">{title}</h2>
      {people.data.map((p) => <PersonRow key={p.id} person={p} action={<FollowButton profileId={p.id} following={false} small />} />)}
    </section>
  );
}

// ── Explore ────────────────────────────────────────────────────────────────────────────────
export function Explore() {
  const [text, setText] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [q, setQ] = useState(text.trim());
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      history.replaceState(null, "", text.trim() ? `/explore?q=${encodeURIComponent(text.trim())}` : "/explore");
    }, 250);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="page">
      <label className="search">
        <Search size={18} aria-hidden />
        <input type="search" placeholder="Search people and captions" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
        {text && <button className="icon-btn" onClick={() => setText("")} aria-label="Clear search"><X size={16} /></button>}
      </label>
      {q ? <SearchResults q={q} /> : <Discover />}
    </div>
  );
}

function SearchResults({ q }: { q: string }) {
  const people = useQueryState(api.profiles.search, { text: q.slice(0, 60) });
  const posts = useQueryState(api.posts.search, { text: q.slice(0, 100) });
  if (people.error || posts.error) return <Failure error={(people.error ?? posts.error)!} />;
  if (!people.data || !posts.data) return <Spinner />;
  if (!people.data.length && !posts.data.posts.length) return <Empty icon={<Search size={30} strokeWidth={1.4} />} title={`No results for “${q}”`}>Try a username, a name, or a word from a caption.</Empty>;
  return (
    <>
      {people.data.length > 0 && (
        <section className="results">
          <h2 className="section-title">People</h2>
          {people.data.map((p) => <PersonRow key={p.id} person={p} />)}
        </section>
      )}
      {posts.data.posts.length > 0 && (
        <section className="results">
          <h2 className="section-title">Posts</h2>
          <Grid posts={posts.data.posts} />
        </section>
      )}
    </>
  );
}

/** A paginated grid: the first page is live, later pages are added as you scroll. */
function useGrid(fetchPage: (cursor?: number) => Promise<{ posts: Tile[]; nextCursor: number | null }>, live: { posts: Tile[]; nextCursor: number | null } | undefined) {
  const [older, setOlder] = useState<Tile[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const next = cursor === undefined ? live?.nextCursor ?? null : cursor;
  const load = () => {
    if (busy || next == null) return;
    setBusy(true);
    fetchPage(next).then((p) => (setOlder((o) => [...o, ...p.posts]), setCursor(p.nextCursor))).finally(() => setBusy(false));
  };
  const sentinel = useSentinel(load, next != null && !busy);
  const posts = useMemo(() => [...(live?.posts ?? []), ...older.filter((o) => !live?.posts.some((p) => p.id === o.id))], [live, older]);
  return { posts, sentinel, busy };
}

function Discover() {
  const client = useFeltKit();
  const recent = useQueryState(api.posts.recent, { limit: 24 });
  const grid = useGrid((cursor) => client.query(api.posts.recent, { cursor, limit: 24 }), recent.data);
  if (recent.error) return <Failure error={recent.error} />;
  return (
    <>
      <Suggestions title="Discover people" />
      <h2 className="section-title">Recent</h2>
      {!recent.data ? <Spinner /> : grid.posts.length ? <Grid posts={grid.posts} /> : <Empty icon={<Compass size={30} strokeWidth={1.4} />} title="Nothing here yet">Photos people share will appear here.</Empty>}
      <div ref={grid.sentinel} />
      {grid.busy && <Spinner />}
    </>
  );
}

// ── Create ─────────────────────────────────────────────────────────────────────────────────
export function Create() {
  const client = useFeltKit();
  const uploadLink = useMutation(api.posts.uploadLink);
  const create = useMutation(api.posts.create);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>();
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<"idle" | "sharing">("idle");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) return setPreview(undefined);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setStatus("sharing");
    setError(undefined);
    try {
      const { blob, width, height } = await prepareImage(file);
      const uploaded = await client.uploadFile(await uploadLink(), blob, { name: "photo.jpg", contentType: "image/jpeg" });
      const id = await create({ fileId: uploaded.id, caption, width, height });
      navigate(`/p/${id}`, true);
    } catch (err) {
      setError((err as Error).message);
      setStatus("idle");
    }
  };
  return (
    <form className="page create" onSubmit={submit}>
      <h1 className="page-title">New post</h1>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {preview ? (
        <div className="create-preview">
          <img src={preview} alt="Selected photo" />
          <button type="button" className="secondary small change" onClick={() => input.current?.click()}>Change</button>
        </div>
      ) : (
        <button type="button" className="dropzone" onClick={() => input.current?.click()}>
          <ImagePlus size={44} strokeWidth={1.2} />
          <span>Choose a photo</span>
          <span className="muted">JPEG, PNG, WebP or GIF</span>
        </button>
      )}
      <label className="field">
        <span className="sr-only">Caption</span>
        <textarea placeholder="Write a caption…" maxLength={2200} rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary wide" disabled={!file || status === "sharing"}>{status === "sharing" ? "Sharing…" : "Share"}</button>
    </form>
  );
}

// ── Notifications ──────────────────────────────────────────────────────────────────────────
const VERB: Record<string, string> = { "post.liked": "liked your photo.", "post.commented": "commented on your photo.", "user.followed": "started following you." };

export function Notifications() {
  const items = useQueryState(api.inbox.list);
  const markAllRead = useMutation(api.inbox.markAllRead);
  const hasUnread = items.data?.some((n) => !n.read);
  useEffect(() => {
    if (hasUnread) {
      const t = setTimeout(() => void markAllRead().catch(() => undefined), 1500);
      return () => clearTimeout(t);
    }
  }, [hasUnread]);
  return (
    <div className="page">
      <h1 className="page-title">Notifications</h1>
      {items.error ? <Failure error={items.error} /> : !items.data ? <Spinner /> : items.data.length === 0 ? (
        <Empty icon={<Bell size={30} strokeWidth={1.4} />} title="No activity yet">When someone likes or comments on your photos, or follows you, you'll see it here.</Empty>
      ) : (
        <ul className="notifications">
          {items.data.map((n) => (
            <li key={n.id} className={n.read ? "" : "unread"}>
              {n.actor ? <Link to={`/u/${n.actor.username}`}><Avatar user={n.actor} size={44} /></Link> : <span className="avatar" />}
              <p>
                {n.actor && <Link to={`/u/${n.actor.username}`} className="username">{n.actor.username}</Link>} {VERB[n.type] ?? n.title} <span className="muted">{ago(n.createdAt)}</span>
              </p>
              {n.postId ? <Link to={`/p/${n.postId}`} className="notif-go">View</Link> : n.actor && <Link to={`/u/${n.actor.username}`} className="notif-go">Profile</Link>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Profile ────────────────────────────────────────────────────────────────────────────────
export function Profile({ username }: { username: string }) {
  const client = useFeltKit();
  const profile = useQueryState(api.profiles.get, { username });
  const id = profile.data?.id;
  const posts = useQueryState(api.posts.byAuthor, id ? { profileId: id, limit: 24 } : "skip");
  const grid = useGrid((cursor) => client.query(api.posts.byAuthor, { profileId: id!, cursor, limit: 24 }), posts.data);
  const [list, setList] = useState<"followers" | "following" | null>(null);
  if (profile.error) return <Failure error={profile.error} />;
  if (profile.data === undefined) return <Spinner />;
  if (profile.data === null) return <Empty icon={<Search size={30} strokeWidth={1.4} />} title="This account doesn't exist">The link may be broken, or the account may have been renamed.</Empty>;
  const p = profile.data;
  return (
    <div className="page profile">
      <header className="profile-head">
        <Avatar user={p} size={96} />
        <div className="profile-info">
          <div className="profile-top">
            <h1>{p.username}</h1>
            {p.isMe ? <Link to="/settings" className="button secondary small">Edit profile</Link> : <FollowButton profileId={p.id} following={p.followedByMe} small />}
          </div>
          <ul className="stats">
            <li><strong>{p.postCount.toLocaleString()}</strong> {p.postCount === 1 ? "post" : "posts"}</li>
            <li><button onClick={() => setList("followers")}><strong>{p.followerCount.toLocaleString()}</strong> {p.followerCount === 1 ? "follower" : "followers"}</button></li>
            <li><button onClick={() => setList("following")}><strong>{p.followingCount.toLocaleString()}</strong> following</button></li>
          </ul>
          <div className="bio">
            <strong>{p.displayName}</strong>
            {p.bio && <p>{p.bio}</p>}
          </div>
        </div>
      </header>
      {!posts.data ? <Spinner /> : grid.posts.length ? <Grid posts={grid.posts} /> : <Empty icon={EmptyGridIcon} title={p.isMe ? "Share your first photo" : "No posts yet"}>{p.isMe && <Link to="/create">Create a post</Link>}</Empty>}
      <div ref={grid.sentinel} />
      {list && <Connections profileId={p.id} side={list} onClose={() => setList(null)} />}
    </div>
  );
}

function Connections({ profileId, side, onClose }: { profileId: string; side: "followers" | "following"; onClose: () => void }) {
  const people = useQueryState(side === "followers" ? api.profiles.followers : api.profiles.following, { profileId });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal aria-label={side} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{side === "followers" ? "Followers" : "Following"}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </header>
        <div className="modal-body" onClick={(e) => (e.target as HTMLElement).closest("a") && onClose()}>
          {!people.data ? <Spinner /> : people.data.length ? people.data.map((u) => <PersonRow key={u.id} person={u} />) : <p className="muted center">Nobody yet.</p>}
        </div>
      </div>
    </div>
  );
}

// ── Post ───────────────────────────────────────────────────────────────────────────────────
export function PostView({ id }: { id: string }) {
  const post = useQueryState(api.posts.get, { id });
  const comment = useMutation(api.social.comment);
  const uncomment = useMutation(api.social.uncomment);
  const remove = useMutation(api.posts.remove);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  if (post.error) return <Failure error={post.error} />;
  if (post.data === undefined) return <Spinner />;
  if (post.data === null) return <Empty icon={EmptyGridIcon} title="This post isn't available">It may have been deleted.</Empty>;
  const p = post.data;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await comment({ postId: p.id, text });
      setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="post-view">
      <Photo fileId={p.fileId} alt={p.caption || `Photo by ${p.author.username}`} ratio={p.width / p.height} className="post-photo" />
      <section className="post-side">
        <header className="card-head">
          <Byline user={p.author} />
          {p.mine && (
            <button className="icon-btn danger" aria-label="Delete post" onClick={() => confirm("Delete this post?") && remove({ id: p.id }).then(() => navigate(`/u/${p.author.username}`, true))}>
              <Trash2 size={18} />
            </button>
          )}
        </header>
        <div className="thread">
          {p.caption && (
            <div className="thread-item">
              <Avatar user={p.author} size={32} />
              <p><Link to={`/u/${p.author.username}`} className="username">{p.author.username}</Link> {p.caption}<span className="muted block small">{ago(p.createdAt)}</span></p>
            </div>
          )}
          {p.comments.map((c) => (
            <div key={c.id} className="thread-item">
              <Avatar user={c.author} size={32} />
              <p><Link to={`/u/${c.author.username}`} className="username">{c.author.username}</Link> {c.text}<span className="muted block small">{ago(c.createdAt)}</span></p>
              {c.mine && <button className="icon-btn subtle" aria-label="Delete comment" onClick={() => uncomment({ id: c.id })}><Trash2 size={14} /></button>}
            </div>
          ))}
          {!p.caption && !p.comments.length && <p className="muted center">No comments yet. Start the conversation.</p>}
        </div>
        <PostActions post={p} />
        <form className="comment-form" onSubmit={send}>
          <input placeholder="Add a comment…" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Add a comment" />
          <button className="link-btn" disabled={!text.trim() || sending}>Post</button>
        </form>
      </section>
    </div>
  );
}

function PostActions({ post }: { post: { id: string; likedByMe: boolean; likeCount: number; createdAt: number } }) {
  const { liked, count, toggle } = useLike(post);
  return (
    <div className="post-actions">
      <LikeButton liked={liked} onClick={toggle} />
      <div className="likes">{plural(count, "like")}</div>
    </div>
  );
}

// ── Settings (edit profile) ────────────────────────────────────────────────────────────────
export function Settings({ me }: { me: Me & { bio?: string } }) {
  const client = useFeltKit();
  const { signOut } = useSession();
  const update = useMutation(api.profiles.update);
  const avatarLink = useMutation(api.profiles.avatarUploadLink);
  const [displayName, setDisplayName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio ?? "");
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});
  const input = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setState({ busy: true });
    try {
      await fn();
      setState({ saved: true });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  const changeAvatar = (file: File) =>
    run(async () => {
      const { blob } = await prepareImage(file, 400);
      const uploaded = await client.uploadFile(await avatarLink(), blob, { name: "avatar.jpg", contentType: "image/jpeg" });
      await update({ avatarFileId: uploaded.id });
    });
  return (
    <form className="page settings" onSubmit={(e) => (e.preventDefault(), run(() => update({ displayName, bio })))}>
      <h1 className="page-title">Edit profile</h1>
      <div className="avatar-row">
        <Avatar user={me} size={64} />
        <div>
          <strong>{me.username}</strong>
          <button type="button" className="link-btn block" onClick={() => input.current?.click()}>Change profile photo</button>
        </div>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && changeAvatar(e.target.files[0])} />
      </div>
      <label className="field">
        <span>Name</span>
        <input value={displayName} maxLength={60} required onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="field">
        <span>Bio</span>
        <textarea value={bio} maxLength={300} rows={3} onChange={(e) => setBio(e.target.value)} />
      </label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="row">
        <button className="primary" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</button>
        {state.saved && <span className="muted" role="status">Saved</span>}
      </div>
      <hr />
      <div className="row spread">
        <span>Appearance</span>
        <ThemeToggle />
      </div>
      <button type="button" className="secondary wide" onClick={() => void signOut().then(() => navigate("/", true))}>Log out</button>
    </form>
  );
}
