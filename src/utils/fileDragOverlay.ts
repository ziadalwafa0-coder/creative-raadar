/**
 * Utility to manage file drag-and-drop overlays reliably.
 * Solves the issue where inner drop zones stop event propagation (stopPropagation),
 * which would otherwise leave the window drag overlay stuck open.
 * Attaches to window in the CAPTURE phase, and resets on Escape, dragend, or blur.
 */

export interface DragOverlayOptions {
  onDragStateChange: (isDragging: boolean) => void;
  onFileDrop: (file: File) => void;
  acceptMimePrefix?: string;
  onError?: (message: string) => void;
}

export function setupWindowDragDropListeners(options: DragOverlayOptions): () => void {
  const {
    onDragStateChange,
    onFileDrop,
    acceptMimePrefix = 'image/',
    onError,
  } = options;

  let dragCounter = 0;

  const resetOverlay = () => {
    dragCounter = 0;
    onDragStateChange(false);
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter += 1;
    if (e.dataTransfer?.types?.includes('Files')) {
      onDragStateChange(true);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter -= 1;
    if (dragCounter <= 0) {
      resetOverlay();
    }
  };

  const handleDrop = (e: DragEvent) => {
    // CAPTURE phase handler ensures overlay is ALWAYS cleared even if child elements stop propagation
    e.preventDefault();
    resetOverlay();

    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (acceptMimePrefix && !file.type.startsWith(acceptMimePrefix)) {
        if (onError) onError('يرجى اختيار ملف صالح');
        return;
      }
      onFileDrop(file);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      resetOverlay();
    }
  };

  const handleDragEnd = () => {
    resetOverlay();
  };

  const handleBlur = () => {
    resetOverlay();
  };

  // Add listeners with capture: true for drop and dragleave to prevent inner element stopPropagation leaks
  window.addEventListener('dragenter', handleDragEnter);
  window.addEventListener('dragover', handleDragOver);
  window.addEventListener('dragleave', handleDragLeave, { capture: true });
  window.addEventListener('drop', handleDrop, { capture: true });
  window.addEventListener('dragend', handleDragEnd);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('blur', handleBlur);

  return () => {
    window.removeEventListener('dragenter', handleDragEnter);
    window.removeEventListener('dragover', handleDragOver);
    window.removeEventListener('dragleave', handleDragLeave, { capture: true });
    window.removeEventListener('drop', handleDrop, { capture: true });
    window.removeEventListener('dragend', handleDragEnd);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('blur', handleBlur);
  };
}
