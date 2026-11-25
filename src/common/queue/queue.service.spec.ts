import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { NOTIFICATION_EMAIL_JOB_OPTIONS, QueueService } from './queue.service';

describe('QueueService', () => {
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
    getJobCounts: jest.fn(),
  };
  let service: QueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QueueService(queue as never);
  });

  it('rejects invalid job payloads before enqueueing', async () => {
    await expect(service.enqueueNotificationEmail({ to: 'not-an-email' })).rejects.toThrow(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a validated notification email job', async () => {
    const job = { id: 'job-1', getState: jest.fn().mockResolvedValue('waiting') };
    queue.add.mockResolvedValue(job);

    await expect(
      service.enqueueNotificationEmail({
        userId: 'user-1',
        notificationId: 'notification-1',
        to: 'student@example.com',
        subject: 'Welcome',
        text: 'Welcome to SorobanLard',
        type: NotificationType.COURSE_APPROVED,
      }),
    ).resolves.toEqual({ id: 'job-1', status: 'waiting' });
    expect(queue.add).toHaveBeenCalledWith(
      'send-notification-email',
      expect.objectContaining({ to: 'student@example.com' }),
      NOTIFICATION_EMAIL_JOB_OPTIONS,
    );
  });

  it('hides jobs belonging to another user', async () => {
    queue.getJob.mockResolvedValue({ data: { userId: 'another-user' } });

    await expect(service.getJobStatus('job-1', 'user-1')).rejects.toThrow(NotFoundException);
  });

  describe('getQueueMetrics', () => {
    it('reports zero totals and a zero failure rate for an empty queue', async () => {
      queue.getJobCounts.mockResolvedValue({
        active: 0,
        waiting: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      });

      await expect(service.getQueueMetrics()).resolves.toEqual({
        active: 0,
        waiting: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
        total: 0,
        failureRate: 0,
      });
    });

    it('sums all counted states into total and derives failureRate from finished jobs', async () => {
      queue.getJobCounts.mockResolvedValue({
        active: 2,
        waiting: 3,
        delayed: 4,
        completed: 6,
        failed: 2,
        paused: 1,
      });

      await expect(service.getQueueMetrics()).resolves.toEqual({
        active: 2,
        waiting: 3,
        delayed: 4,
        completed: 6,
        failed: 2,
        paused: 1,
        total: 18,
        failureRate: 0.25,
      });
    });

    it('returns a failure rate of 1 when only failed jobs exist', async () => {
      queue.getJobCounts.mockResolvedValue({
        active: 0,
        waiting: 0,
        delayed: 0,
        completed: 0,
        failed: 5,
        paused: 0,
      });

      await expect(service.getQueueMetrics()).resolves.toEqual({
        active: 0,
        waiting: 0,
        delayed: 0,
        completed: 0,
        failed: 5,
        paused: 0,
        total: 5,
        failureRate: 1,
      });
    });
  });
});
