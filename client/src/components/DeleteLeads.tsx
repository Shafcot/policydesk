// Super Admin: confirm and permanently delete one or more leads.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { Modal } from './ui';

export function DeleteLeadsModal({ ids, label, onClose, onDeleted }: { ids: string[]; label: string; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const del = useMutation({
    mutationFn: () => api<{ deleted: number }>('/leads/delete', { method: 'POST', json: { ids } }),
    onSuccess: (r) => {
      ['leads', 'dashboard', 'queue', 'inbox', 'appointments', 'tasks'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast(`${r.deleted} ${r.deleted === 1 ? 'lead' : 'leads'} deleted`);
      onDeleted();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not delete', 'alert'),
  });
  return (
    <Modal title={`Delete ${label}?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary danger-fill" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete permanently'}</button></>}>
      <p>This removes {ids.length === 1 ? 'the lead' : 'these leads'} with all calls, recordings, notes, messages, appointments and tasks. It can’t be undone.</p>
      <p className="muted">Customers and policies already created from a won lead are kept.</p>
    </Modal>
  );
}
