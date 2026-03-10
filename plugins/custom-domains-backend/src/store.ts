import { Knex } from 'knex';

export interface CustomDomain {
  id: string;
  team: string;
  service: string;
  domain: string;
  auto_domain: string;
  status: 'pending' | 'verified' | 'active' | 'failed';
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class CustomDomainStore {
  constructor(private readonly db: Knex) {}

  async initialize(): Promise<void> {
    const hasTable = await this.db.schema.hasTable('custom_domains');
    if (!hasTable) {
      await this.db.schema.createTable('custom_domains', table => {
        table.string('id').primary();
        table.string('team').notNullable();
        table.string('service').notNullable();
        table.string('domain').notNullable().unique();
        table.string('auto_domain').notNullable();
        table
          .enum('status', ['pending', 'verified', 'active', 'failed'])
          .defaultTo('pending');
        table.timestamp('verified_at').nullable();
        table.string('created_by').notNullable();
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
        table.index(['team', 'service']);
      });
    }
  }

  async list(team: string, service?: string): Promise<CustomDomain[]> {
    const query = this.db<CustomDomain>('custom_domains').where({ team });
    if (service) {
      query.andWhere({ service });
    }
    return query.orderBy('created_at', 'desc');
  }

  async getByDomain(domain: string): Promise<CustomDomain | undefined> {
    return this.db<CustomDomain>('custom_domains')
      .where({ domain })
      .first();
  }

  async getById(id: string): Promise<CustomDomain | undefined> {
    return this.db<CustomDomain>('custom_domains')
      .where({ id })
      .first();
  }

  async create(entry: Omit<CustomDomain, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    await this.db('custom_domains').insert({
      ...entry,
      created_at: now,
      updated_at: now,
    });
  }

  async updateStatus(
    id: string,
    status: CustomDomain['status'],
    verifiedAt?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (verifiedAt) {
      update.verified_at = verifiedAt;
    }
    await this.db('custom_domains').where({ id }).update(update);
  }

  async delete(id: string): Promise<void> {
    await this.db('custom_domains').where({ id }).delete();
  }

  async deleteByDomain(domain: string): Promise<void> {
    await this.db('custom_domains').where({ domain }).delete();
  }
}
