import type { PrismaClient } from "@prisma/client";
import type {
  CreateAliasInput,
  UpdateAliasDestinationsInput,
  AliasListQuery,
  AliasResponse,
} from "@vexlyx/shared";
import { MailService } from "../mail/service.js";
import type { FastifyBaseLogger } from "fastify";

export class AliasError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "AliasError";
  }
}

export class AliasService {
  private readonly mailService: MailService;

  constructor(
    private readonly prisma: PrismaClient,
    logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {
    this.mailService = new MailService(prisma, logger);
  }

  /**
   * Lists aliases owned by the user, optionally filtered by domain.
   */
  async list(userId: string, query: AliasListQuery): Promise<AliasResponse[]> {
    const aliases = await this.prisma.virtualAlias.findMany({
      where: {
        userId,
        ...(query.domainId ? { domainId: query.domainId } : {}),
      },
      include: { domain: true },
      orderBy: { createdAt: "desc" },
    });

    return aliases.map((a) => this.toResponse(a));
  }

  /**
   * Creates an alias under a domain owned by the user. A catch-all is stored
   * as "@domain.com" (no local part) and is capped at one per domain.
   */
  async create(userId: string, input: CreateAliasInput): Promise<AliasResponse> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: input.domainId, userId },
    });

    if (!domain) {
      throw new AliasError("Domain not found or unauthorized", "DOMAIN_NOT_FOUND", 404);
    }

    if (input.isCatchAll) {
      const existingCatchAll = await this.prisma.virtualAlias.findFirst({
        where: { domainId: domain.id, isCatchAll: true },
      });
      if (existingCatchAll) {
        throw new AliasError(
          `This domain already has a catch-all alias (${existingCatchAll.source}). Delete it first to create a new one.`,
          "CATCH_ALL_EXISTS",
          409,
        );
      }
    }

    const source = (input.isCatchAll ? `@${domain.hostname}` : `${input.localPart}@${domain.hostname}`).toLowerCase();

    const existing = await this.prisma.virtualAlias.findUnique({ where: { source } });
    if (existing) {
      throw new AliasError("Alias address already exists", "ALIAS_EXISTS", 409);
    }

    const destinations = input.destinations.map((d) => d.toLowerCase());

    const alias = await this.prisma.virtualAlias.create({
      data: {
        source,
        destinations,
        isCatchAll: input.isCatchAll,
        userId,
        domainId: domain.id,
      },
      include: { domain: true },
    });

    try {
      await this.mailService.syncVirtualAliases(userId);
    } catch {
      // Non-fatal: the alias exists regardless of sync outcome. The user can
      // still trigger a sync manually via the mail dashboard.
    }

    return this.toResponse(alias);
  }

  /**
   * Replaces an existing alias's destination list.
   */
  async updateDestinations(
    userId: string,
    aliasId: string,
    input: UpdateAliasDestinationsInput,
  ): Promise<void> {
    const alias = await this.prisma.virtualAlias.findFirst({
      where: { id: aliasId, userId },
    });

    if (!alias) {
      throw new AliasError("Alias not found or unauthorized", "ALIAS_NOT_FOUND", 404);
    }

    await this.prisma.virtualAlias.update({
      where: { id: alias.id },
      data: { destinations: input.destinations.map((d) => d.toLowerCase()) },
    });

    try {
      await this.mailService.syncVirtualAliases(userId);
    } catch {
      // Non-fatal, see create().
    }
  }

  /**
   * Deletes an alias.
   */
  async delete(userId: string, aliasId: string): Promise<void> {
    const alias = await this.prisma.virtualAlias.findFirst({
      where: { id: aliasId, userId },
    });

    if (!alias) {
      throw new AliasError("Alias not found or unauthorized", "ALIAS_NOT_FOUND", 404);
    }

    await this.prisma.virtualAlias.delete({ where: { id: alias.id } });

    try {
      await this.mailService.syncVirtualAliases(userId);
    } catch {
      // Non-fatal, see create().
    }
  }

  private toResponse(alias: {
    id: string;
    source: string;
    destinations: string[];
    isCatchAll: boolean;
    domainId: string;
    domain: { hostname: string };
    createdAt: Date;
  }): AliasResponse {
    return {
      id: alias.id,
      source: alias.source,
      localPart: alias.isCatchAll ? null : (alias.source.split("@")[0] ?? null),
      domainId: alias.domainId,
      hostname: alias.domain.hostname,
      destinations: alias.destinations,
      isCatchAll: alias.isCatchAll,
      createdAt: alias.createdAt.toISOString(),
    };
  }
}
