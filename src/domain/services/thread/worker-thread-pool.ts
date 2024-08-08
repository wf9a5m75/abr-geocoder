/*!
 * MIT License
 *
 * Copyright (c) 2024 デジタル庁
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fromSharedMemory, toSharedMemory } from './shared-memory';
import { ThreadJob, ThreadJobResult, ThreadPing, ThreadPong } from './thread-task';

export class WorkerPoolTaskInfo<T, R> extends AsyncResource {

  constructor(
    public readonly data: T,
    public readonly resolve: (value: R) => void,
    public readonly reject: (err: Error) => void,
  ) {
    super('WorkerPoolTaskInfo');
  }

  done(err: null | undefined | Error, result?: R) {
    if (err) {
      this.runInAsyncScope(this.reject, this, err);
    } else {
      this.runInAsyncScope(this.resolve, this, result);
    }
    this.emitDestroy();
  }
}

export class WorkerThread<I, T, R> extends Worker {
  private resolvers: Map<number, (data: R) => void> = new Map();
  private tasks: Map<number, WorkerPoolTaskInfo<T, R>> = new Map();
  private _total: number = 0;
  public get totalTasks(): number {
    return this._total;
  };

  private _numOfTasks: number = 0;
  public get numOfTasks(): number {
    return this._numOfTasks;
  };

  public getTasks(): WorkerPoolTaskInfo<T, R>[] {
    return Array.from(this.tasks.values());
  }

  private constructor(params: {
    filename: string | URL,
    initData?: I,
  }) {
    const name = path.basename(params.filename.toString());
    super(params.filename, {
      workerData: params.initData,
      name,
      // execArgv: ['--inspect-brk'],
      stdout: false,
      stderr: false,
    });

    this.on('message', (shareMemory: Uint8Array) => {
      const received = fromSharedMemory<ThreadJobResult<R> | ThreadPong>(shareMemory);

      if (received.kind !== 'result') {
        return;
      }

      // if (received.kind !== 'result') {
      //   this.emit('custom_message', received as ThreadMessage<any>);
      //   return;
      // }
      
      // addTask で生成した Promise の resolve を実行する
      const taskId = received.taskId;
      const resolve = this.resolvers.get(taskId);
      if (!resolve) {
        throw new Error(`can not find resolver for ${taskId}`);
      }

      this.tasks.delete(taskId);
      this.resolvers.delete(taskId);
      this._numOfTasks--;
      resolve(received.data);
    });
  }
  private initAsync(signal?: AbortSignal) {
    return new Promise((
      resolve: (_?: unknown) => void,
      reject: (_?: unknown) => void,
    ) => {
      signal?.addEventListener('abort', () => {
        this.terminate();
        reject('canceled');
      })

      const listener = (shareMemory: Uint8Array) => {
        const received = fromSharedMemory<ThreadPong>(shareMemory);
        if (received.kind !== 'pong') {
          return;
        }
        this.off('message', listener);
        resolve();
      };

      this.on('message', listener);
      this.postMessage(toSharedMemory({
        kind: 'ping',
      } as ThreadPing));
    });
  }

  // スレッド側にタスクを送る
  addTask(task: WorkerPoolTaskInfo<T, R>) {
    this._total++;
    this._numOfTasks++;
    return new Promise((resolve: (data: R) => void) => {
      let taskId = Math.floor(performance.now() + Math.random()  * performance.now());
      while (this.tasks.has(taskId)) {
        taskId = Math.floor(performance.now() + Math.random()  * performance.now());
      }
      this.tasks.set(taskId, task);
  
      this.postMessage(toSharedMemory<ThreadJob<T>>({
        taskId,
        kind: 'task',
        data: task.data,
      }));

      this.resolvers.set(taskId, resolve);
    });
  }

  static readonly create = async <I, T, R>(params: {
    filename: string | URL;
    initData?: I;
    signal?: AbortSignal;
  }) => {
    const worker = new WorkerThread<I, T, R>(params);
    await new Promise((
      resolve: (worker: WorkerThread<I, T, R>) => void,
      reject: (reason: unknown) => void,
    ) => {
      worker.initAsync(params.signal).then(() => {
        resolve(worker);
      })
      .catch((reason: unknown) => {
        reject(reason);
      })
    });
    return worker;
  }
}

export class WorkerThreadPool<InitData, TransformData, ReceiveData> extends EventEmitter {
  private readonly kWorkerFreedEvent = Symbol('kWorkerFreedEvent');
  private workers: WorkerThread<InitData, TransformData, ReceiveData>[] = [];
  private readonly abortControl = new AbortController();

  private waitingTasks: WorkerPoolTaskInfo<TransformData, ReceiveData>[] = [];

  static readonly create = <InitData, TransformData, ReceiveData>(params : {
    filename: string;
    initData?: InitData;
    // 最大いくつまでのワーカーを生成するか
    maxConcurrency: number;
    // 1つの worker にいくつのタスクを同時に実行させるか
    maxTasksPerWorker: number;

    signal?: AbortSignal;
  }): Promise<WorkerThreadPool<InitData, TransformData, ReceiveData>> => {
    const pool = new WorkerThreadPool<InitData, TransformData, ReceiveData>();
    return new Promise((
      resolve: (pool: WorkerThreadPool<InitData, TransformData, ReceiveData>) => void,
      reject: (reason: unknown) => void,
    ) => {
      pool.initAsync(params).then(() => {
        resolve(pool);
      })
      .catch((reason: unknown) => {
        reject(reason);
      })
    });
  }

  private constructor() {
    super();
  }

  private async initAsync(params : {
    filename: string;
    initData?: InitData;
    // 最大いくつまでのワーカーを生成するか
    maxConcurrency: number;
    // 1つの worker にいくつのタスクを同時に実行させるか
    maxTasksPerWorker: number;

    signal?: AbortSignal;
  }) {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < params.maxConcurrency; i++) {
      tasks.push(this.addWorker({
        filename: params.filename,
        initData: params.initData,
        signal: params.signal,
      }));
      if (params.signal?.aborted) {
        break;
      }
    }
    await Promise.all(tasks);
    if (params.signal?.aborted) {
      this.close();
      return;
    }

    // タスクが挿入 or 1つタスクが完了したら、次のタスクを実行する
    // (ラウンドロビン方式で、各スレッドに均等にタスクを割り当てる)
    let nextIdx = 0;
    this.on(this.kWorkerFreedEvent, async () => {
      const task = this.waitingTasks.shift();
      if (task === undefined) {
        return;
      }
      const worker = this.workers[nextIdx];
      nextIdx = (nextIdx + 1) % this.workers.length;
      worker.addTask(task)
        .then((data: ReceiveData) => {
          // run() で生成した Promise の resolve を実行する
          task.done(null, data);
        })
        .finally(() => {
          // キューをシフトさせる
          this.emit(this.kWorkerFreedEvent);
        })
    });
  }

  private async createWorker(params: {
    filename: string;
    initData?: InitData;
    signal?: AbortSignal;
  }) {
    if (params.signal?.aborted) {
      return;
    }
    const worker = await new Promise((
      resolve: (worker: WorkerThread<InitData, TransformData, ReceiveData>) => void,
      reject: (reason?: any) => void,
    ) => {

      WorkerThread.create<InitData, TransformData, ReceiveData>(params)
        .then(worker => {
          resolve(worker);
        })
        .catch((reason: unknown) => {
          reject(reason);
        })
    });
    
    worker.on('error', async (error: Error) => {
      worker.removeAllListeners();
      console.error(error);

      // エラーが発生したら、rejectを呼び出す
      // (どうするかは呼び出し元で考える)
      const failedTasks = worker.getTasks();
      failedTasks.forEach(task => {
        if (error instanceof Error) {
          task.done(error);
        }
      });
      if (this.abortControl.signal.aborted) {
        worker.terminate();
        return;
      }

      // 終了したスレッドは新しいスレッドに置換する
      const newWorker = await this.createWorker({
        filename: params.filename,
        initData: params.initData,
        signal: this.abortControl.signal,
      }).catch((reason: unknown) => {
        console.error(reason);
      })
      if (!newWorker) {
        return;
      }
      const idx = this.workers.indexOf(worker);
      if (idx > -1) {
        this.workers[idx] = newWorker;
      }
      worker.terminate();

      // 次のタスクを実行する
      this.emit(this.kWorkerFreedEvent);
    });
    if (this.abortControl.signal.aborted) {
      worker.terminate();
      return;
    }
    return worker;
  }

  private async addWorker(params: {
    filename: string;
    initData?: InitData;
    signal?: AbortSignal;
  }) {
    const worker = await this.createWorker(params)
      .catch((reason: unknown) => {
        if (typeof reason === 'string' && reason === 'canceled') {
          return;
        }
        console.error(reason);
      });
    if (!worker) {
      return;
    }

    worker.on('custom_message', data => {
      this.emit('custom_message', data);
    })
    this.workers.push(worker);

    // エラーのときに再作成する場合、キューにタスクが溜まっているかもしれないので
    // 次のタスクを実行する
    this.emit(this.kWorkerFreedEvent);
  }

  // 全スレッドに対してメッセージを送信する
  // broadcastMessage<M>(data: M) {
  //   if (this.isClosed) {
  //     return Promise.reject('Called broadcastMessage() after closed.');
  //   }
  //   const sharedMemory = toSharedMemory<ThreadMessage<M>>({
  //     kind: 'message',
  //     data,
  //   });

  //   for (const worker of this.noMoreTasks.values()) {
  //     worker.postMessage(sharedMemory);
  //   }
  //   this.heap.forEach(worker => {
  //     worker.postMessage(sharedMemory);
  //   });
  // }

  async run(workerData: TransformData): Promise<ReceiveData> {
    if (this.abortControl.signal.aborted) {
      return Promise.reject('Called run() after closed.');
    }

    return await new Promise((
      resolve: (value: ReceiveData) => void,
      reject: (err: Error) => void,
    ) => {
      // タスクキューに入れる
      this.waitingTasks.push(new WorkerPoolTaskInfo(
        workerData,
        resolve,
        reject,
      ));
      
      // タスクキューから次のタスクを取り出して実行する
      this.emit(this.kWorkerFreedEvent);
    });
  }

  close() {
    if (this.abortControl.signal.aborted) {
      return;
    }
    // await this.broadcastMessage<{
    //   kind: 'signal';
    //   data: 'before-close'
    // }>({
    //   kind: 'signal',
    //   data: 'before-close',
    // });

    this.abortControl.abort();

    this.workers.forEach(worker => {
      worker.terminate();
    });
  }
}