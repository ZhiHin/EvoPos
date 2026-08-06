ALTER POLICY "branches_tenant_isolation" ON "branches" TO evoapp USING ("branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "branches_qr_lookup" ON "branches" TO evoapp USING (exists (
        select 1
        from dining_tables dt
        where dt.branch_id = "branches"."id"
          and dt.qr_token = nullif(current_setting('app.qr_token', true), '')
      ));--> statement-breakpoint
ALTER POLICY "restaurants_tenant_isolation" ON "restaurants" TO evoapp USING ("restaurants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("restaurants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "restaurants_member_read" ON "restaurants" TO evoapp USING (exists (
        select 1
        from memberships m
        where m.restaurant_id = "restaurants"."id"
          and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          and m.status = 'active'
      ));--> statement-breakpoint
ALTER POLICY "restaurants_qr_lookup" ON "restaurants" TO evoapp USING (exists (
        select 1
        from dining_tables dt
        where dt.restaurant_id = "restaurants"."id"
          and dt.qr_token = nullif(current_setting('app.qr_token', true), '')
      ));--> statement-breakpoint
ALTER POLICY "dining_tables_tenant_isolation" ON "dining_tables" TO evoapp USING ("dining_tables"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_tables"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "dining_tables_qr_lookup" ON "dining_tables" TO evoapp USING ("dining_tables"."qr_token" = nullif(current_setting('app.qr_token', true), ''));--> statement-breakpoint
ALTER POLICY "floors_tenant_isolation" ON "floors" TO evoapp USING ("floors"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("floors"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_attribute_definitions_tenant_isolation" ON "menu_attribute_definitions" TO evoapp USING ("menu_attribute_definitions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_attribute_definitions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_categories_tenant_isolation" ON "menu_categories" TO evoapp USING ("menu_categories"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_categories"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_categories_diner_read" ON "menu_categories" TO evoapp USING ("menu_categories"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_availability_tenant_isolation" ON "menu_item_availability" TO evoapp USING ("menu_item_availability"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_availability"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_branches_tenant_isolation" ON "menu_item_branches" TO evoapp USING ("menu_item_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_tags_tenant_isolation" ON "menu_item_tags" TO evoapp USING ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_tags_diner_read" ON "menu_item_tags" TO evoapp USING ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_items_tenant_isolation" ON "menu_items" TO evoapp USING ("menu_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_items_diner_read" ON "menu_items" TO evoapp USING ("menu_items"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_tags_tenant_isolation" ON "menu_tags" TO evoapp USING ("menu_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_tags_diner_read" ON "menu_tags" TO evoapp USING ("menu_tags"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combo_group_items_tenant_isolation" ON "combo_group_items" TO evoapp USING ("combo_group_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combo_group_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combo_group_items_diner_read" ON "combo_group_items" TO evoapp USING ("combo_group_items"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combo_groups_tenant_isolation" ON "combo_groups" TO evoapp USING ("combo_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combo_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combo_groups_diner_read" ON "combo_groups" TO evoapp USING ("combo_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combos_tenant_isolation" ON "combos" TO evoapp USING ("combos"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combos"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "combos_diner_read" ON "combos" TO evoapp USING ("combos"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_modifier_groups_tenant_isolation" ON "menu_item_modifier_groups" TO evoapp USING ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "menu_item_modifier_groups_diner_read" ON "menu_item_modifier_groups" TO evoapp USING ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "modifier_groups_tenant_isolation" ON "modifier_groups" TO evoapp USING ("modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "modifier_groups_diner_read" ON "modifier_groups" TO evoapp USING ("modifier_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "modifier_option_branches_tenant_isolation" ON "modifier_option_branches" TO evoapp USING ("modifier_option_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_option_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "modifier_options_tenant_isolation" ON "modifier_options" TO evoapp USING ("modifier_options"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_options"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "modifier_options_diner_read" ON "modifier_options" TO evoapp USING ("modifier_options"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "dining_session_members_tenant_isolation" ON "dining_session_members" TO evoapp USING ("dining_session_members"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_session_members"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "dining_session_members_token_lookup" ON "dining_session_members" TO evoapp USING ("dining_session_members"."token_hash" = nullif(current_setting('app.member_token', true), ''));--> statement-breakpoint
ALTER POLICY "dining_session_members_peers_read" ON "dining_session_members" TO evoapp USING ("dining_session_members"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "dining_sessions_tenant_isolation" ON "dining_sessions" TO evoapp USING ("dining_sessions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_sessions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "dining_sessions_member_read" ON "dining_sessions" TO evoapp USING ("dining_sessions"."id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_line_modifiers_tenant_isolation" ON "order_line_modifiers" TO evoapp USING ("order_line_modifiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("order_line_modifiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_line_modifiers_member_read" ON "order_line_modifiers" TO evoapp USING ("order_line_modifiers"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_line_modifiers_member_insert" ON "order_line_modifiers" TO evoapp WITH CHECK ("order_line_modifiers"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_lines_tenant_isolation" ON "order_lines" TO evoapp USING ("order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_lines_member_read" ON "order_lines" TO evoapp USING ("order_lines"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "order_lines_member_insert" ON "order_lines" TO evoapp WITH CHECK ("order_lines"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "service_requests_tenant_isolation" ON "service_requests" TO evoapp USING ("service_requests"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("service_requests"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "service_requests_member_read" ON "service_requests" TO evoapp USING ("service_requests"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "service_requests_member_insert" ON "service_requests" TO evoapp WITH CHECK ("service_requests"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "session_discounts_tenant_isolation" ON "session_discounts" TO evoapp USING ("session_discounts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("session_discounts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "session_discounts_member_read" ON "session_discounts" TO evoapp USING ("session_discounts"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "membership_branches_tenant_isolation" ON "membership_branches" TO evoapp USING ("membership_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("membership_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "memberships_tenant_isolation" ON "memberships" TO evoapp USING ("memberships"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("memberships"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "memberships_self_read" ON "memberships" TO evoapp USING ("memberships"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "role_permissions_tenant_isolation" ON "role_permissions" TO evoapp USING ("role_permissions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("role_permissions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "roles_tenant_isolation" ON "roles" TO evoapp USING ("roles"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("roles"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "roles_member_read" ON "roles" TO evoapp USING (exists (
        select 1
        from memberships m
        where m.role_id = "roles"."id"
          and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          and m.status = 'active'
      ));--> statement-breakpoint
ALTER POLICY "audit_log_tenant_read" ON "audit_log" TO evoapp USING ("audit_log"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "audit_log_tenant_insert" ON "audit_log" TO evoapp WITH CHECK ("audit_log"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);