import {
  Injectable,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SmsService } from '../../common/sms/sms.service';

export class TooManyRequestsException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyRequestsException';
  }
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly OTP_LENGTH = 6;
  private readonly OTP_EXPIRY_MINUTES = 10;
  private readonly MAX_ATTEMPTS = 5;
  private readonly RATE_LIMIT_WINDOW_MINUTES = 15;
  private readonly MAX_REQUESTS_PER_WINDOW = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp(userId: string, phoneNumber: string, countryCode: string): Promise<void> {
    // Rate limiting check
    const recentOtps = await this.prisma.phoneOtp.count({
      where: {
        userId,
        createdAt: {
          gte: new Date(Date.now() - this.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000),
        },
      },
    });

    if (recentOtps >= this.MAX_REQUESTS_PER_WINDOW) {
      throw new TooManyRequestsException(
        `Too many OTP requests. Please try again after ${this.RATE_LIMIT_WINDOW_MINUTES} minutes.`,
      );
    }

    // Invalidate any existing unused OTPs
    await this.prisma.phoneOtp.updateMany({
      where: {
        userId,
        phoneNumber,
        isUsed: false,
      },
      data: {
        isUsed: true,
      },
    });

    // Generate new OTP
    const otp = this.generateOtp();
    const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000);

    // Save OTP to database
    const phoneOtp = await this.prisma.phoneOtp.create({
      data: {
        userId,
        phoneNumber,
        countryCode,
        otp,
        expiresAt,
      },
    });

    // Send OTP via SMS
    try {
      await this.smsService.sendSms(phoneNumber, `Your verification code is: ${otp}`);
    } catch (error) {
      // Invalidate the OTP so a failed send does not leave a usable code behind
      await this.prisma.phoneOtp.update({
        where: { id: phoneOtp.id },
        data: { isUsed: true },
      });

      this.logger.error(
        `Failed to send OTP SMS to ${phoneNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Failed to send OTP. Please try again.');
    }

    // Log OTP only in development
    if (this.configService.get('NODE_ENV') === 'development') {
      this.logger.log(`[DEV] OTP for ${phoneNumber}: ${otp}`);
    } else {
      this.logger.log(`OTP sent to ${phoneNumber}`);
    }
  }

  async verifyOtp(userId: string, phoneNumber: string, otp: string): Promise<boolean> {
    const phoneOtp = await this.prisma.phoneOtp.findFirst({
      where: {
        userId,
        phoneNumber,
        isUsed: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!phoneOtp) {
      throw new UnauthorizedException('No valid OTP found. Please request a new one.');
    }

    // Check if OTP has expired
    if (new Date() > phoneOtp.expiresAt) {
      await this.prisma.phoneOtp.update({
        where: { id: phoneOtp.id },
        data: { isUsed: true },
      });
      throw new UnauthorizedException('OTP has expired. Please request a new one.');
    }

    // Check max attempts
    if (phoneOtp.attemptCount >= this.MAX_ATTEMPTS) {
      await this.prisma.phoneOtp.update({
        where: { id: phoneOtp.id },
        data: { isUsed: true },
      });
      throw new UnauthorizedException('Maximum verification attempts exceeded. Please request a new OTP.');
    }

    // Verify OTP
    if (phoneOtp.otp !== otp) {
      await this.prisma.phoneOtp.update({
        where: { id: phoneOtp.id },
        data: { attemptCount: phoneOtp.attemptCount + 1 },
      });
      throw new UnauthorizedException('Invalid OTP. Please try again.');
    }

    // Mark OTP as used
    await this.prisma.phoneOtp.update({
      where: { id: phoneOtp.id },
      data: {
        isUsed: true,
        verifiedAt: new Date(),
      },
    });

    // Update user phone verification status
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber,
        phoneCountryCode: phoneOtp.countryCode,
        isPhoneVerified: true,
        phoneVerifiedAt: new Date(),
      },
    });

    return true;
  }

  async getVerificationStatus(userId: string): Promise<{
    isPhoneVerified: boolean;
    phoneNumber: string | null;
    phoneVerifiedAt: Date | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isPhoneVerified: true,
        phoneNumber: true,
        phoneVerifiedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      isPhoneVerified: user.isPhoneVerified,
      phoneNumber: user.phoneNumber,
      phoneVerifiedAt: user.phoneVerifiedAt,
    };
  }

  private generateOtp(): string {
    return Math.floor(Math.random() * Math.pow(10, this.OTP_LENGTH))
      .toString()
      .padStart(this.OTP_LENGTH, '0');
  }
}
