import { NextResponse } from 'next/server';
import { enqueueManualScan } from '@/lib/scan-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  try {
    const jobId = await enqueueManualScan();
    return NextResponse.json(
      jobId === null
        ? { status: 'coalesced' as const, jobId: null }
        : { status: 'queued' as const, jobId },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error: unknown) {
    console.error('[web:scan-queue] could not enqueue manual scan', error);
    return NextResponse.json(
      { error: 'The scan could not be queued. Check that the worker and database are running.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
