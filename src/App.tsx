import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SignIn, useMutation, useQueryState, useSession } from "@feltdb/feltkit/react";
import { Compass, Heart, House, SquarePlus } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import { Avatar, Link, navigate, usePath } from "./lib";
import { Create, Explore, Home, Notifications, PostView, Profile, Settings } from "./pages";

export function App() {
  const { session } = useSession();
  if (!session) return <Splash />;
  if (!session.principal) return <Welcome />;
  return <Signed key={session.principal.id} name={session.principal.displayName} />;
}

const Wordmark = ({ size = 28 }: { size?: number }) => (
  <span className="wordmark" style={{ fontSize: size }}>
    <span className="mark" aria-hidden />
    frame
  </span>
);

const Splash = () => (
  <div className="splash">
    <Wordmark size={40} />
  </div>
);

/** Not signed in: FeltKit's own sign-in / sign-up screen (it also offers the dev users in development). */
function Welcome() {
  return (
    <main className="welcome">
      <section className="welcome-art" aria-hidden>
        <div className="collage">
          {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} />)}
        </div>
      </section>
      <section className="welcome-form">
        <Wordmark size={44} />
        <p className="tagline">See the world through the people you follow.</p>
        <SignIn bare initialMode="sign-in" />
      </section>
    </main>
  );
}

/** Signed in: choose a username first, then the app. */
function Signed({ name }: { name?: string }) {
  const me = useQueryState(api.profiles.me);
  if (me.error) return <div className="splash"><p className="form-error">{me.error.message}</p></div>;
  if (me.data === undefined) return <Splash />;
  if (me.data === null) return <Onboarding name={name} />;
  return <Shell me={me.data} />;
}

function Onboarding({ name }: { name?: string }) {
  const create = useMutation(api.profiles.create);
  const { signOut } = useSession();
  const [username, setUsername] = useState((name ?? "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30));
  const [displayName, setDisplayName] = useState(name ?? "");
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    create({ username, displayName }).catch((err: Error) => setError(err.message));
  };
  return (
    <main className="welcome single">
      <form className="welcome-form card-form" onSubmit={submit}>
        <Wordmark size={36} />
        <h1>Choose your username</h1>
        <p className="muted">This is how people find you. Letters, numbers, periods and underscores.</p>
        <label className="field">
          <span>Username</span>
          <input value={username} minLength={3} maxLength={30} pattern="[a-z0-9._]+" required autoFocus onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={displayName} maxLength={60} required onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary wide">Continue</button>
        <button type="button" className="link-btn" onClick={() => void signOut()}>Use another account</button>
      </form>
    </main>
  );
}

type Me = { id: string; username: string; displayName: string; avatarFileId?: string; bio?: string };

function Shell({ me }: { me: Me }) {
  const path = usePath();
  const unread = useQueryState(api.inbox.unreadCount);
  const badge = (unread.data ?? 0) > 0 && !path.startsWith("/notifications");
  const nav: Array<{ to: string; label: string; icon: ReactNode; mobile?: boolean }> = [
    { to: "/", label: "Home", icon: <House /> },
    { to: "/explore", label: "Explore", icon: <Compass /> },
    { to: "/create", label: "Create", icon: <SquarePlus /> },
    { to: "/notifications", label: "Notifications", icon: <span className="badge-wrap"><Heart />{badge && <span className="dot" aria-label="Unread" />}</span> },
    { to: `/u/${me.username}`, label: "Profile", icon: <Avatar user={me} size={26} /> },
  ];
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link to="/" className="brand"><Wordmark /></Link>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-item ${active(n.to) ? "active" : ""}`} aria-current={active(n.to) ? "page" : undefined}>
            {n.icon}
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <header className="topbar">
        <Link to="/" className="brand"><Wordmark size={24} /></Link>
      </header>
      <main className="content">
        <Route path={path} me={me} />
      </main>
      <nav className="bottombar" aria-label="Main">
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`tab ${active(n.to) ? "active" : ""}`} aria-label={n.label} aria-current={active(n.to) ? "page" : undefined}>
            {n.icon}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Route({ path, me }: { path: string; me: Me }) {
  const [, section, arg] = path.split("/");
  useEffect(() => {
    const titles: Record<string, string> = { explore: "Explore", create: "New post", notifications: "Notifications", settings: "Edit profile", p: "Post" };
    document.title = section === "u" && arg ? `@${decodeURIComponent(arg)} · Frame` : titles[section ?? ""] ? `${titles[section!]} · Frame` : "Frame";
  }, [section, arg]);
  switch (section) {
    case "":
      return <Home />;
    case "explore":
      return <Explore />;
    case "create":
      return <Create />;
    case "notifications":
      return <Notifications />;
    case "settings":
      return <Settings me={me} />;
    case "u":
      return arg ? <Profile key={arg} username={decodeURIComponent(arg)} /> : <Home />;
    case "p":
      return arg ? <PostView key={arg} id={decodeURIComponent(arg)} /> : <Home />;
    default:
      return <div className="state"><h3>Page not found</h3><Link to="/">Go home</Link></div>;
  }
}

