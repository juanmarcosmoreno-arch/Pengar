import type { ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Suricata } from './Suricata';

/**
 * Pedir confirmación dentro de la app (sin confirm() del navegador). Al confirmar, llama a onConfirm y se cierra.
 * `extra`: algo más debajo del mensaje (como «Guardar un respaldo antes»)
 */
export function ConfirmSheet({ title, message, confirmLabel, danger = false, extra, onConfirm, onClose }: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  extra?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <button className="btn-outline flex-1" onClick={onClose}>Cancelar</button>
          <button
            className={`btn-primary flex-1 ${danger ? 'bg-danger' : ''}`}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="flex items-center gap-4 pb-2">
        <Suricata pose={danger ? 'cara-preocupado' : 'cara-pensando'} size={72} className="shrink-0" />
        <div className="text-lg">{message}</div>
      </div>
      {extra}
    </Sheet>
  );
}

/** Un aviso con un solo botón («Entendido»): lo que no se puede hacer ahora y por qué */
export function NoticeSheet({ title, message, onClose }: { title: string; message: ReactNode; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose} footer={<button className="btn-primary w-full" onClick={onClose}>Entendido</button>}>
      <div className="flex items-center gap-4 pb-2">
        <Suricata pose="cara-pensando" size={72} className="shrink-0" />
        <div className="text-lg">{message}</div>
      </div>
    </Sheet>
  );
}
