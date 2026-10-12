import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalStorage, S3Storage, STORAGE, type Storage } from './storage';

@Global()
@Module({
  controllers: [MediaController],
  providers: [
    {
      provide: STORAGE,
      useFactory: (env: Env): Storage =>
        env.STORAGE_DRIVER === 'local' ? new LocalStorage(env) : new S3Storage(env),
      inject: [ENV],
    },
    MediaService,
  ],
  exports: [MediaService, STORAGE],
})
export class MediaModule {}
