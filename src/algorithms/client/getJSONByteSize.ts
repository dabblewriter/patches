/** Estimate JSON string byte size. */
export function getJSONByteSize(data: any): number {
  try {
    const stringified = JSON.stringify(data);
    return stringified ? new TextEncoder().encode(stringified).length : 0;
  } catch (e) {
    // Handle circular structures (from JSON.stringify) or other errors.
    console.error('Error calculating JSON size:', e);
    throw new Error('Error calculating JSON size: ' + e);
  }
}
