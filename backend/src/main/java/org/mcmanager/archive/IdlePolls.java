package org.mcmanager.archive;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.async.WebAsyncTask;
import jakarta.annotation.PreDestroy;

/** Hold an empty poll outside database transactions and servlet threads, waking on new work. */
@Component
class IdlePolls {
    private static final class Slot {
        long revision;
        synchronized long revision(){return revision;}
        synchronized void wake(){revision++;notifyAll();}
        synchronized boolean await(long seen,long millis)throws InterruptedException{
            long end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(millis);
            while(revision==seen){long left=end-System.nanoTime();if(left<=0)return false;TimeUnit.NANOSECONDS.timedWait(this,left);}
            return true;
        }
    }
    private final ConcurrentHashMap<String,Slot> slots=new ConcurrentHashMap<>();
    private final Semaphore capacity=new Semaphore(128);
    private final SimpleAsyncTaskExecutor executor=new SimpleAsyncTaskExecutor("idle-poll-");
    private final int seconds;
    IdlePolls(@Value("${MCM_IDLE_POLL_SECONDS:8}") int seconds){this.seconds=Math.max(0,Math.min(15,seconds));executor.setVirtualThreads(true);}
    void wake(String key){var slot=slots.get(key);if(slot!=null)slot.wake();}
    <T> Object poll(String key,Supplier<T> query,Predicate<T> empty){
        return poll(key,query,empty,seconds);
    }
    <T> Object poll(String key,Supplier<T> query,Predicate<T> empty,int maximumSeconds){
        int waitSeconds=Math.min(seconds,maximumSeconds);
        if(waitSeconds==0||slots.size()>2048)return query.get();
        var slot=slots.computeIfAbsent(key,k->new Slot());long seen=slot.revision();T first=query.get();
        if(!empty.test(first)||!capacity.tryAcquire())return first;
        var released=new AtomicBoolean();Runnable release=()->{if(released.compareAndSet(false,true))capacity.release();};
        // No notification means the first empty result is still safe to return.
        // Do not compete with a bulk upload for database locks on every timeout.
        // Unsignalled work/lease expiry is picked up by the next normal request.
        // The authentication filters still revalidate every async response.
        var task=new WebAsyncTask<Object>(45000L,executor,()->{try{return slot.await(seen,waitSeconds*1000L)?query.get():first;}finally{release.run();}});
        task.onCompletion(release);task.onTimeout(()->{release.run();return first;});return task;
    }
    @PreDestroy void close(){slots.values().forEach(Slot::wake);executor.close();}
}
