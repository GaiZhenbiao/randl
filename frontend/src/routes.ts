export type Route = {
  page: string;
  project: string;
  run?: string;
  runTab?: string;
  artifact?: string;
  artifactRef?: { type: string; name: string; version: string };
  view?: string;
};
export function parseRoute(url: URL): Route {
  const query = url.searchParams;
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { page: 'not-found', project: '' };
  }
  const route: Route = {
    page: query.get('page') || 'overview',
    project: '',
    artifact: query.get('artifact') || undefined,
    view: query.get('view') || undefined,
  };
  if (segments.length >= 2) {
    route.project = segments.slice(0, 2).join('/');
    route.page = segments[2] || 'workspace';
    if (segments[2] === 'runs' && segments[3]) {
      route.page = 'run';
      route.run = route.project + '/' + segments[3];
      route.runTab = segments[4] || 'metrics';
    }
    if (segments[2] === 'artifacts' && segments.length >= 6)
      route.artifactRef = { type: segments[3], name: segments[4], version: segments[5] };
  }
  const allowedLength = route.run ? 5 : route.artifactRef ? 6 : 3;
  if (
    segments.length === 1 ||
    segments.length > allowedLength ||
    (segments.length > 3 && !route.run && !route.artifactRef)
  ) {
    route.page = 'not-found';
    delete route.run;
    delete route.artifactRef;
  }
  return route;
}
export function pageURL(project: string, page: string, view?: string) {
  const base = project
    ? '/' + project.split('/').map(encodeURIComponent).join('/') + '/' + page
    : '/?page=' + page;
  return view ? base + (base.includes('?') ? '&' : '?') + 'view=' + encodeURIComponent(view) : base;
}
