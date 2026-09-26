// Browser-only: hand a file a server function returned as base64 to the
// browser as a download.

/** Word's media type — preview and issued offers are .docx. */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const PDF_MIME = "application/pdf";

export function saveBase64File(base64: string, filename: string, type: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoked after the click is handled: revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
