/** Estimate JSON string byte size. */
export function getJSONByteSize(data: any): number {
  // Basic estimation, might not be perfectly accurate due to encoding nuances
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch (e) {
    // Handle circular structures or other stringify errors
    console.error('Error calculating JSON size:', e);
    return Infinity; // Treat errors as infinitely large
  }
}
