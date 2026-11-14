import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@feltdb/feltkit/react";
import { Heart, LoaderCircle, MessageCircle, Layers } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import type { ResultOf } from "@feltdb/feltkit/client";
import { Avatar, Link, Photo, ago, navigate, plural } from "./lib";

export type Card = ResultOf<typeof api.posts.feed>["posts"][number];
export type Tile = ResultOf<typeof api.posts.recent>["posts"][number];
export type Person = ResultOf<typeof api.profiles.search>[number];

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <div className="state" role="status">
    <LoaderCircle className="spin" size={22} aria-hidden />
    <span className="sr-only">{label}</span>
  </div>
);

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export const Failure = ({ error }: { error: { message: string } }) => (
  <div className="state error" role="alert">
    <h3>Something went wrong</h3>
    <p>{error.message}</p>
  </div>
);

/** Like state with an immediate response; the live query confirms it a moment later. */
export function useLike(post: { id: string; likedByMe: boolean; likeCount: number }) {
  const like = useMutation(api.social.like);
  const unlike = useMutation(api.social.unlike);
  const [local, setLocal] = useState<{ liked: boolean; count: number } | null>(null);
  useEffect(() => setLocal(null), [post.likedByMe, post.likeCount]);
  const liked = local?.liked ?? post.likedByMe;
  const count = local?.count ?? post.likeCount;
  const set = (next: boolean) => {
    if (next === liked) return;
    setLocal({ liked: next, count: count + (next ? 1 : -1) });
    (next ? like : unlike)({ postId: post.id }).catch(() => setLocal(null));
  };
  return { liked, count, toggle: () => set(!liked), like: () => set(true) };
}

export function LikeButton({ liked, onClick }: { liked: boolean; onClick: () => void }) {
  return (
    <button className={`icon-btn like ${liked ? "on" : ""}`} onClick={onClick} aria-pressed={liked} aria-label={liked ? "Unlike" : "Like"}>
      <Heart size={24} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 1.8} />
    </button>
  );
}

export function Byline({ user, time }: { user: Person; time?: number }) {
  return (
    <div className="byline">
      <Link to={`/u/${user.username}`} className="byline-user">
        <Avatar user={user} size={32} />
        <span className="username">{user.username}</span>
      </Link>
      {time !== undefined && <span className="muted">· {ago(time)}</span>}
    </div>
  );
}

export function PostCard({ post }: { post: Card }) {
  const { liked, count, toggle, like } = useLike(post);
  const [burst, setBurst] = useState(0);
  const open = () => navigate(`/p/${post.id}`);
  return (
    <article className="card" aria-label={`Post by ${post.author.username}`}>
      <header className="card-head">
        <Byline user={post.author} time={post.createdAt} />
      </header>
      <div className="card-media">
        <Photo fileId={post.fileId} alt={post.caption || `Photo by ${post.author.username}`} ratio={Math.max(0.8, Math.min(1.91, post.width / post.height))} onDoubleClick={() => (like(), setBurst((n) => n + 1))} />
        {burst > 0 && <Heart key={burst} className="burst" size={96} fill="currentColor" strokeWidth={0} aria-hidden />}
      </div>
      <div className="card-body">
        <div className="actions">
          <LikeButton liked={liked} onClick={toggle} />
          <button className="icon-btn" onClick={open} aria-label="Comment">
            <MessageCircle size={24} strokeWidth={1.8} />
          </button>
        </div>
        <div className="likes">{plural(count, "like")}</div>
        {post.caption && (
          <p className="caption">
            <Link to={`/u/${post.author.username}`} className="username">{post.author.username}</Link> {post.caption}
          </p>
        )}
        {post.commentCount > post.comments.length && (
          <Link to={`/p/${post.id}`} className="muted more-comments">View all {post.commentCount} comments</Link>
        )}
        {post.comments.map((c) => (
          <p key={c.id} className="comment-line">
            <Link to={`/u/${c.author.username}`} className="username">{c.author.username}</Link> {c.text}
          </p>
        ))}
      </div>
    </article>
  );
}

export function Grid({ posts }: { posts: Tile[] }) {
  return (
    <div className="grid">
      {posts.map((p) => (
        <Link key={p.id} to={`/p/${p.id}`} className="tile" aria-label={`Post with ${plural(p.likeCount, "like")}`}>
          <Photo fileId={p.fileId} alt="" />
          <span className="tile-stats" aria-hidden>
            <span><Heart size={18} fill="currentColor" strokeWidth={0} /> {p.likeCount}</span>
            <span><MessageCircle size={18} fill="currentColor" strokeWidth={0} /> {p.commentCount}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

export function FollowButton({ profileId, following, small }: { profileId: string; following: boolean; small?: boolean }) {
  const follow = useMutation(api.social.follow);
  const unfollow = useMutation(api.social.unfollow);
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => setLocal(null), [following]);
  const on = local ?? following;
  return (
    <button
      className={`${on ? "secondary" : "primary"} ${small ? "small" : ""}`}
      onClick={() => {
        setLocal(!on);
        (on ? unfollow : follow)({ profileId }).catch(() => setLocal(null));
      }}
    >
      {on ? "Following" : "Follow"}
    </button>
  );
}

export function PersonRow({ person, action }: { person: Person; action?: ReactNode }) {
  return (
    <div className="person">
      <Link to={`/u/${person.username}`} className="person-link">
        <Avatar user={person} size={44} />
        <span>
          <span className="username">{person.username}</span>
          <span className="muted block">{person.displayName}</span>
        </span>
      </Link>
      {action}
    </div>
  );
}

export const EmptyGridIcon = <Layers size={30} strokeWidth={1.4} />;
