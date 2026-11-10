package org.mcmanager.archive;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.context.request.async.WebAsyncTask;
import static org.junit.jupiter.api.Assertions.*;

class IdlePollsTest {
    @Test void emptyTimeoutDoesNotReenterDatabase() throws Exception {
        var polls=new IdlePolls(1);var queries=new AtomicInteger();
        try {
            var task=(WebAsyncTask<?>)polls.poll("empty",()->{queries.incrementAndGet();return List.of();},List::isEmpty);
            assertEquals(List.of(),task.getCallable().call());
            assertEquals(1,queries.get(),"An idle timeout must not wait on a second database lock");
        } finally {polls.close();}
    }
    @Test void notificationBetweenInitialReadAndWaitIsNotLost() throws Exception {
        var polls=new IdlePolls(8);var queries=new AtomicInteger();
        try {
            var task=(WebAsyncTask<?>)polls.poll("work",()->queries.incrementAndGet()==1?List.of():List.of("task"),List::isEmpty);
            polls.wake("work");
            assertEquals(List.of("task"),task.getCallable().call());assertEquals(2,queries.get());
        } finally {polls.close();}
    }
}
