/**
 * Research Events Service
 * EventEmitter singleton for pipeline progress tracking
 */

import { EventEmitter } from 'events';
import type {
  ResearchEvent,
  ResearchStage,
  ResearchJobCounters,
} from './research.types.js';

class ResearchEventsService extends EventEmitter {
  private activeJobs: Set<string> = new Set();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  isJobActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  emitResearchStarted(jobId: string, projectId: string, theme: string): void {
    this.activeJobs.add(jobId);
    const event: ResearchEvent = {
      type: 'research:started',
      jobId,
      projectId,
      theme,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitStageStarted(
    jobId: string,
    projectId: string,
    stage: ResearchStage,
    message: string
  ): void {
    const event: ResearchEvent = {
      type: 'research:stage_started',
      jobId,
      projectId,
      stage,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitStageProgress(
    jobId: string,
    projectId: string,
    stage: ResearchStage,
    processed: number,
    total: number,
    percentage: number,
    message?: string
  ): void {
    const event: ResearchEvent = {
      type: 'research:stage_progress',
      jobId,
      projectId,
      stage,
      processed,
      total,
      percentage,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitStageCompleted(
    jobId: string,
    projectId: string,
    stage: ResearchStage,
    stats: Partial<ResearchJobCounters>,
    message?: string
  ): void {
    const event: ResearchEvent = {
      type: 'research:stage_completed',
      jobId,
      projectId,
      stage,
      stats,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitResearchLog(
    jobId: string,
    projectId: string,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info'
  ): void {
    const event: ResearchEvent = {
      type: 'research:log',
      jobId,
      projectId,
      message,
      level,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitResearchCompleted(
    jobId: string,
    projectId: string,
    stats: ResearchJobCounters,
    message?: string
  ): void {
    this.activeJobs.delete(jobId);
    const event: ResearchEvent = {
      type: 'research:completed',
      jobId,
      projectId,
      stats,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }

  emitResearchError(
    jobId: string,
    projectId: string,
    error: string,
    stats?: Partial<ResearchJobCounters>
  ): void {
    this.activeJobs.delete(jobId);
    const event: ResearchEvent = {
      type: 'research:error',
      jobId,
      projectId,
      error,
      stats,
      timestamp: new Date().toISOString(),
    };
    this.emit('research:event', event);
  }
}

// Singleton export
export const researchEvents = new ResearchEventsService();
