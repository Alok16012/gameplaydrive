"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Check, X, ArrowDownLeft, Plus } from "lucide-react";
import type { Account } from "../lib/hierarchy";

export function PaymentRequestsView({ me }: { me: any }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRequests = async () => {
    setLoading(true);
    let q = supabase().from("payment_requests").select(`
      *,
      profiles (
        code,
        name,
        username
      )
    `).order("created_at", { ascending: false });

    const { data, error } = await q;
    if (data && !error) {
      setRequests(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadRequests();
  }, [me]);

  const updateStatus = async (id: string, status: string) => {
    await supabase().from("payment_requests").update({ status }).eq("id", id);
    loadRequests();
  };

  return (
    <div className="fadein space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Payment Requests</h1>
        <p className="text-white/50 text-sm mt-1">Manage player deposit and withdrawal requests</p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-white/10 text-white/50 text-xs uppercase">
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 font-semibold">Player</th>
              <th className="px-4 py-3 font-semibold">Type</th>
              <th className="px-4 py-3 font-semibold">Amount / UTR</th>
              <th className="px-4 py-3 font-semibold">Bank Details</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-white/50 animate-pulse">Loading...</td></tr>
            ) : requests.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-white/50">No requests found.</td></tr>
            ) : (
              requests.map(r => (
                <tr key={r.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3 text-white/70">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-gold-300">{r.profiles?.code || 'Unknown'}</td>
                  <td className="px-4 py-3">
                    {r.type === 'withdraw' ? (
                      <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold bg-rose-500/10 px-2 py-1 rounded"><ArrowDownLeft size={14} /> Withdraw</span>
                    ) : (
                      <span className="flex items-center gap-1 text-neon-400 text-xs font-semibold bg-neon-500/10 px-2 py-1 rounded"><Plus size={14} /> Deposit</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white font-semibold">
                    {r.type === 'withdraw' ? `🪙 ${r.amount}` : `UTR: ${r.utr}`}
                  </td>
                  <td className="px-4 py-3 text-white/70 min-w-[250px] whitespace-normal break-words" title={r.bank_details}>
                    {r.bank_details || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${
                      r.status === 'pending' ? 'bg-amber-500/10 text-amber-400' :
                      r.status === 'approved' ? 'bg-emerald-500/10 text-emerald-400' :
                      'bg-rose-500/10 text-rose-400'
                    }`}>
                      {r.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {r.status === 'pending' && (
                      <>
                        <button onClick={() => updateStatus(r.id, 'approved')} className="p-1.5 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/40 rounded transition" title="Approve">
                          <Check size={16} />
                        </button>
                        <button onClick={() => updateStatus(r.id, 'rejected')} className="p-1.5 bg-rose-500/20 text-rose-400 hover:bg-rose-500/40 rounded transition" title="Reject">
                          <X size={16} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
