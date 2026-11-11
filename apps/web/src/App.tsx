/**
 * Application shell and router.
 *
 * Both hash and path routes are supported, because the signing links handed
 * to a recipient are plain paths (`/sign/:token`) that work in an email
 * client, while the dashboard navigation uses the hash.
 *
 * Routes:
 *   #/                  Dashboard with the list of signature requests
 *   #/new               New request: upload, recipients, field placement
 *   #/envelopes/:id     Detail, recipients and audit trail
 *   /sign/:token        Public signing room for a recipient
 */
import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { Editor } from './views/Editor';
import { EnvelopeDetailView } from './views/EnvelopeDetail';
import { SigningRoom } from './views/SigningRoom';

type Route =
  | { name: 'dashboard' }
  | { name: 'new' }
  | { name: 'envelope'; id: string }
  | { name: 'sign'; token: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').trim();
  if (!path) return { name: 'dashboard' };
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'new') return { name: 'new' };
  if (segments[0] === 'envelopes' && segments[1]) return { name: 'envelope', id: segments[1] };
  if (segments[0] === 'sign' && segments[1]) return { name: 'sign', token: segments[1] };
  return { name: 'dashboard' };
}

/**
 * Resolves the current route. A path such as `/sign/:token` wins over the
 * hash, so a signing link pasted as a full URL opens the signing room.
 */
function parseRoute(): Route {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const pathSegments = path.split('/').filter(Boolean);
  if (pathSegments[0] === 'sign' && pathSegments[1]) {
    return { name: 'sign', token: pathSegments[1] };
  }
  return parseHash(window.location.hash);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const isPublic = route.name === 'sign';

  return (
    <div className="app-shell">
      {!isPublic && (
        <header className="topbar">
          <a className="brand" href="#/">
            <span className="brand-mark">D</span>
            <span>DEPARTIFY</span>
            <span className="brand-sub">Signature</span>
          </a>
          <div className="grow" />
          <a className="btn btn-primary btn-sm" href="#/new">
            Nueva solicitud
          </a>
        </header>
      )}

      {route.name === 'dashboard' && <Dashboard />}
      {route.name === 'new' && <Editor />}
      {route.name === 'envelope' && <EnvelopeDetailView envelopeId={route.id} />}
      {route.name === 'sign' && <SigningRoom token={route.token} />}
    </div>
  );
}
