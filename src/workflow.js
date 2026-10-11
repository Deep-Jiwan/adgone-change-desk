// Status workflow and permission rules. Pure functions, no I/O, so they are easy to test.

export const STATUSES = ['new', 'review', 'approved', 'in_progress', 'testing', 'completed', 'rejected'];
export const CATEGORIES = ['bug', 'feature', 'improvement', 'ui'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const ROLES = ['admin', 'developer', 'requester'];

// from -> allowed next statuses
export const TRANSITIONS = {
  new: ['review', 'rejected'],
  review: ['approved', 'rejected', 'new'],
  approved: ['in_progress', 'review', 'rejected'],
  in_progress: ['testing', 'approved'],
  testing: ['completed', 'in_progress'],
  completed: ['in_progress'], // reopen
  rejected: ['new'], // reopen
};

// Moves that must carry an explanation (stored as a comment).
const NOTE_REQUIRED = new Set(['*>rejected', 'testing>in_progress', 'completed>in_progress', 'rejected>new']);

export const DEFAULT_PROGRESS = {
  new: 0, review: 10, approved: 20, in_progress: 50, testing: 80, completed: 100, rejected: 0,
};

export const isStaff = (user) => user.role === 'admin' || user.role === 'developer';

export function noteRequired(from, to) {
  return NOTE_REQUIRED.has(`${from}>${to}`) || NOTE_REQUIRED.has(`*>${to}`);
}

/**
 * Can `user` move a request from `from` to `to`?
 * Staff (admin/developer) drive the workflow. The requester signs off on testing,
 * can reopen their own completed request and resubmit their own rejected one.
 * Only the requester or an admin can accept a change (testing -> completed).
 */
export function canTransition(user, request, from, to) {
  if (!TRANSITIONS[from]?.includes(to)) return false;
  const owner = request.requester_id === user.id;
  if (from === 'testing' && to === 'completed') return owner || user.role === 'admin';
  if (isStaff(user)) return true;
  // plain requester: only on their own request
  if (!owner) return false;
  return (
    (from === 'testing' && to === 'in_progress') ||
    (from === 'completed' && to === 'in_progress') ||
    (from === 'rejected' && to === 'new')
  );
}

export function allowedTransitions(user, request) {
  return (TRANSITIONS[request.status] || []).filter((to) => canTransition(user, request, request.status, to));
}

/** Can the user edit the descriptive fields (title, description, category, priority)? */
export function canEditDetails(user, request) {
  if (isStaff(user)) return true;
  return request.requester_id === user.id && request.status === 'new';
}
