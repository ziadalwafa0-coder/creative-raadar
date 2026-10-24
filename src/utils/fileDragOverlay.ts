// Capture terminal events: upload widgets may stop drop propagation themselves.
export function bindFileDragOverlay(target: Window, onChange: (active: boolean) => void) {
  const capture = {capture:true};
  let depth = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    depth = 0;
    clearTimeout(timer);
    onChange(false);
  };
  const renew = () => {
    clearTimeout(timer);
    // Some external drag sources never deliver dragleave/dragend on cancellation.
    timer = setTimeout(reset, 1500);
  };
  const enter = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    depth += 1;
    onChange(true);
    renew();
  };
  const over = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    onChange(true);
    renew();
  };
  const leave = (event: DragEvent) => {
    depth = Math.max(0, depth - 1);
    if (!event.relatedTarget || depth === 0) reset();
  };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') reset(); };
  const visibility = () => { if (target.document.hidden) reset(); };
  target.addEventListener('dragenter', enter, capture);
  target.addEventListener('dragover', over, capture);
  target.addEventListener('dragleave', leave, capture);
  target.addEventListener('drop', reset, capture);
  target.addEventListener('dragend', reset, capture);
  target.addEventListener('keydown', key, capture);
  target.addEventListener('blur', reset);
  target.addEventListener('pointerdown', reset, capture);
  target.document.addEventListener('visibilitychange', visibility);
  return () => {
    clearTimeout(timer);
    target.removeEventListener('dragenter', enter, capture);
    target.removeEventListener('dragover', over, capture);
    target.removeEventListener('dragleave', leave, capture);
    target.removeEventListener('drop', reset, capture);
    target.removeEventListener('dragend', reset, capture);
    target.removeEventListener('keydown', key, capture);
    target.removeEventListener('blur', reset);
    target.removeEventListener('pointerdown', reset, capture);
    target.document.removeEventListener('visibilitychange', visibility);
  };
}
