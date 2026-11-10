package org.mcmanager.archive;

import java.time.Duration;
import org.springframework.stereotype.Component;

@Component
class ActivitySignal {
    private long revision;
    synchronized long revision() { return revision; }
    synchronized void published() { revision++; notifyAll(); }
    void publishOnCommit() {
        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                new org.springframework.transaction.support.TransactionSynchronization() {
                    @Override public void afterCommit() { published(); }
                });
    }
    synchronized void await(long seen, Duration remaining) throws InterruptedException {
        if (revision == seen && !remaining.isNegative() && !remaining.isZero())
            wait(Math.max(1, Math.min(remaining.toMillis(), 25_000)));
    }
}
